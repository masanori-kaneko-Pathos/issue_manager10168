import { Injectable, inject } from '@angular/core';
import { NoticeAbout, NotificationService } from '../notification/notification.service';
import {
  DocumentReference, FirestoreError, QueryDocumentSnapshot, Timestamp, Transaction, Unsubscribe, collection,
  doc, getDoc, getDocs, onSnapshot, orderBy, or, query, runTransaction, serverTimestamp, where,
  addDoc, updateDoc, deleteField, deleteDoc, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  CauseCategory, Effect, Issue, IssueLink, IssueRelation, IssueType, Level, LinkKind, Member, NotificationType,
  OPEN_STATUSES, Subtask, SubtaskStatus, TimelineItem, relationId,
} from '../models';
import { TRANSITIONS, Transition, TransitionKey, UNDO_OF } from './workflow';
import { UndoConflictError } from '../undo/undo.service';
import { ImportValues } from '../import/convert';

/** 見張りで届いた文書を課題にする。保存直後の手元の版では、サーバーの時刻が null なので仮の時刻を入れる */
function toIssue(d: QueryDocumentSnapshot): Issue {
  return { ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Issue, 'id'>), id: d.id };
}

/** 開いた時点（base）から、ほかの人が課題を更新していた。latest は今の課題 */
export class ConflictError extends Error {
  constructor(readonly latest: Issue) {
    super('conflict');
  }
}

/** 衝突のメッセージの1文目：だれが先に更新したか（翻訳キーと差し込む値） */
export function conflictWho(
  latest: Issue, members: Member[], myUid: string,
): { key: string; params?: Record<string, string> } {
  if (latest.updatedBy === myUid) return { key: 'conflict.bySelf' };
  const name = members.find((m) => m.uid === latest.updatedBy)?.displayName;
  // updatedBy の無い古い課題や、外れた人のときは「ほかの人」
  return name ? { key: 'conflict.byName', params: { name } } : { key: 'conflict.byOther' };
}

/** トランザクションの中で、課題が base から変わっていないかを確かめる。変わっていたら ConflictError */
async function assertUnchanged(tx: Transaction, ref: DocumentReference, base: Issue) {
  const s = await tx.get(ref);
  if (!s.exists()) throw new Error('issue-not-found');
  const latest = { ...(s.data() as Omit<Issue, 'id'>), id: s.id };
  if (!latest.updatedAt.isEqual(base.updatedAt)) throw new ConflictError(latest);
}

/** 課題の今の値が、edits で書いた値のままか（元に戻す前に、ほかの人が同じ欄を変えていないかを見る） */
function matchesEdits(i: Issue, edits: IssueEdits): boolean {
  return (Object.keys(edits) as (keyof IssueEdits)[]).every((k) => {
    const v = edits[k];
    switch (k) {
      case 'dueAt': return i.dueAt.toMillis() === (v as Date).getTime();
      case 'labelIds': return [...(i.labelIds ?? [])].sort().join() === [...(v as string[])].sort().join();
      case 'occurredOn': return (i.occurredOn ?? null) === (v ?? null);
      case 'impact': return (i.impact ?? '') === v;
      default: return i[k] === v;
    }
  });
}

/** edits で変えた欄の、変える前の値（元に戻すときに書き戻す値） */
export function previousOf(i: Issue, edits: IssueEdits): IssueEdits {
  const prev: IssueEdits = {};
  for (const k of Object.keys(edits) as (keyof IssueEdits)[]) {
    if (k === 'dueAt') prev.dueAt = i.dueAt.toDate();
    else if (k === 'labelIds') prev.labelIds = i.labelIds ?? [];
    else if (k === 'occurredOn') prev.occurredOn = i.occurredOn ?? null;
    else if (k === 'impact') prev.impact = i.impact ?? '';
    else (prev as Record<string, unknown>)[k] = i[k];
  }
  return prev;
}

/** ステータス変更のうち、知らせるものと宛先 */
const STATUS_NOTICE: Partial<Record<TransitionKey, { type: NotificationType; to: 'assignee' | 'reporter' }>> = {
  resolve: { type: 'resolved', to: 'reporter' },   // 提起者に確認してもらう
  sendBack: { type: 'sentBack', to: 'assignee' },
  close: { type: 'closed', to: 'assignee' },
  reject: { type: 'rejected', to: 'reporter' },
};

/** 知らせたい相手と種類 */
interface NoticeWant {
  to: string | null | undefined;
  type: NotificationType;
  detail?: string;
}

export interface NewIssue {
  title: string;
  type: IssueType;
  importance: Level;
  dueAt: Date;
  assigneeId: string;
  doneCriteria: string;
  description: string;
  labelIds: string[];
  occurredOn: string | null;
  impact: string;
  relatedFrom?: IssueLink | null;
  /** 再発として登録するときの、元の課題（同じプロジェクト） */
  recurrenceOf?: { iid: string; number: number } | null;
  /** サブタスクを課題に切り出すときの、親の課題とサブタスク（同じプロジェクト） */
  splitFrom?: { iid: string; sid: string; number: number } | null;
}

export interface StatusPayload {
  reason: string;
  cause: string;
  countermeasure: string;
  causeCategory: CauseCategory | null;
  effect: Effect | null;
  learning: string;
  doneCriteriaMet: boolean;
  /** 解決済みにするとき、回避策を外したと確かめたか */
  workaroundEnded?: boolean;
}

/** 入力が要らないステータス変更（対応を始める・再開）に使う、空の入力 */
export const EMPTY_STATUS_PAYLOAD: StatusPayload = {
  reason: '', cause: '', countermeasure: '', causeCategory: null, effect: null, learning: '', doneCriteriaMet: false,
};

export interface IssueEdits {
  title?: string;
  type?: IssueType;
  importance?: Level;
  dueAt?: Date;
  assigneeId?: string;
  doneCriteria?: string;
  description?: string;
  labelIds?: string[];
  occurredOn?: string | null; // null は「空にする」
  impact?: string;
}

/** サブタスクを足すときの値（状態は未着手から。メモは空から） */
export interface NewSubtask {
  title: string;
  assigneeId: string;
  dueAt: Date | null;
  order: number;
}

/** サブタスクを直すときの値（変えた欄だけ入れる。dueAt の null は「期限を外す」） */
export interface SubtaskEdits {
  title?: string;
  assigneeId?: string;
  dueAt?: Date | null;
  memo?: string;
}

@Injectable({ providedIn: 'root' })
export class IssueService {
  private notifications = inject(NotificationService);
  /**
   * 知らせたい相手のうち、今もメンバーの人にだけ、通知を用意する（トランザクションの中で、書く前に呼ぶ）。
   * 抜けた人を宛先にすると、ルールで断られて保存ごと失敗するので、メンバー文書を読んで確かめる
   */
  private async prepareNotices(
    tx: Transaction, pid: string, issue: { id: string; number: number; title: string }, wants: NoticeWant[],
  ) {
    // 宛先のない人と、同じ人への2通目を除く
    const targets = wants.filter((w, i) => !!w.to && wants.findIndex((x) => x.to === w.to) === i);
    if (!targets.length) return [];
    const [project, ...members] = await Promise.all([
      tx.get(doc(db, 'projects', pid)),
      ...targets.map((w) => tx.get(doc(db, 'projects', pid, 'members', w.to!))),
    ]);
    const about: NoticeAbout = {
      pid, projectName: project.data()?.['name'] ?? '', iid: issue.id, issueNumber: issue.number, issueTitle: issue.title,
    };
    return targets
      .filter((_, i) => members[i].exists())
      .map((w) => this.notifications.notice(w.to, w.type, about, w.detail ?? ''))
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }

  /** 課題番号の採番と、課題・履歴の作成を、1つのトランザクションで行う */
  /** memoId があれば、受信箱のメモも同じトランザクションで消す（課題になったメモを残さないため） */
  create(pid: string, input: NewIssue, uid: string, tz: string, memoId?: string): Promise<number> {
    return runTransaction(db, async (tx) => {
      const projectRef = doc(db, 'projects', pid);
      const project = await tx.get(projectRef);
      // 切り出すサブタスクも、書く前に読む。もう無い・もう切り出し済みなら止める（2人が同時に切り出すと、課題が2つできるため）
      const splitRef = input.splitFrom
        ? doc(projectRef, 'issues', input.splitFrom.iid, 'subtasks', input.splitFrom.sid) : null;
      const split = splitRef ? await tx.get(splitRef) : null;
      if (split && (!split.exists() || split.data()['splitTo'])) throw new Error('split-gone');
      const number = (project.data()!['issueSeq'] as number) + 1;
      const issueRef = doc(collection(projectRef, 'issues'));

      tx.update(projectRef, { issueSeq: number });
      tx.set(issueRef, {
        number,
        title: input.title,
        type: input.type,
        status: 'open',
        importance: input.importance,
        priorityOverride: null,
        dueAt: Timestamp.fromDate(input.dueAt),
        // 登録したときの期限。期限遵守率は、あとで期限を延ばしても、この期限で判定する（仕様メモ【13】）
        firstDueAt: Timestamp.fromDate(input.dueAt),
        startAt: serverTimestamp(),
        doneCriteria: input.doneCriteria,
        description: input.description,
        assigneeId: input.assigneeId,
        reporterId: uid,
        labelIds: input.labelIds,
        occurredOn: input.occurredOn,
        impact: input.impact,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedBy: uid,
        // ひも付けがあるときだけ書く
        ...(input.relatedFrom ? { relatedFrom: input.relatedFrom } : {}),
      });
      tx.set(doc(collection(issueRef, 'events')), { type: 'created', by: uid, tz, at: serverTimestamp() });
      // 再発として登録：新しい課題（再発元を指す）と元の課題（再発した課題を指す）を、登録と同じ封筒でつなぐ
      if (input.recurrenceOf) {
        const src = doc(projectRef, 'issues', input.recurrenceOf.iid);
        tx.set(doc(issueRef, 'links', relationId('recurrence', 'out', pid, src.id)),
          { kind: 'recurrence', dir: 'out', pid, iid: src.id, by: uid, at: serverTimestamp() });
        tx.set(doc(src, 'links', relationId('recurrence', 'in', pid, issueRef.id)),
          { kind: 'recurrence', dir: 'in', pid, iid: issueRef.id, by: uid, at: serverTimestamp() });
        tx.set(doc(collection(src, 'events')), {
          type: 'link', link: { action: 'add', kind: 'recurrence', dir: 'in', pid, iid: issueRef.id, number },
          by: uid, tz, at: serverTimestamp(),
        });
      }
      // 切り出し：サブタスクに印を付け、親と「関連」でつなぎ、親の経緯に残す（登録と同じ封筒で）
      if (split?.exists() && input.splitFrom) {
        const parentRef = doc(projectRef, 'issues', input.splitFrom.iid);
        const subTitle = split.data()['title'] as string;
        tx.update(split.ref, { splitTo: { iid: issueRef.id, number }, updatedAt: serverTimestamp(), updatedBy: uid });
        tx.set(doc(issueRef, 'links', relationId('relates', 'out', pid, parentRef.id)),
          { kind: 'relates', dir: 'out', pid, iid: parentRef.id, by: uid, at: serverTimestamp() });
        tx.set(doc(parentRef, 'links', relationId('relates', 'in', pid, issueRef.id)),
          { kind: 'relates', dir: 'in', pid, iid: issueRef.id, by: uid, at: serverTimestamp() });
        tx.set(doc(collection(parentRef, 'events')), {
          type: 'subtask', sub: { action: 'split', title: subTitle, number }, by: uid, tz, at: serverTimestamp(),
        });
      }
      if (memoId) tx.delete(doc(db, 'users', uid, 'inbox', memoId));
      // 担当者が自分以外なら、担当者に知らせる（自分のときは notice が null を返す）
      const n = this.notifications.notice(input.assigneeId, 'assigned', {
        pid, projectName: project.data()!['name'], iid: issueRef.id, issueNumber: number, issueTitle: input.title,
      });
      if (n) tx.set(n.ref, n.data);
      return number;
    });
  }


  /**
   * 取り込み：1件を登録する。採番は create と同じトランザクション。通知は出さない（50件取り込んで50通を防ぐ）。
   * 管理者は、提起者・ステータス・登録日時を表のとおりに入れられる（ルールで確認）
   */
  importIssue(pid: string, v: ImportValues, importId: string, uid: string, tz: string): Promise<number> {
    return runTransaction(db, async (tx) => {
      const projectRef = doc(db, 'projects', pid);
      const project = await tx.get(projectRef);
      const number = (project.data()!['issueSeq'] as number) + 1;
      const issueRef = doc(collection(projectRef, 'issues'));
      const due = Timestamp.fromDate(v.dueAt);
      const created = v.createdAt ? Timestamp.fromDate(v.createdAt) : serverTimestamp();
      const done = v.status === 'resolved' || v.status === 'closed';

      tx.update(projectRef, { issueSeq: number });
      tx.set(issueRef, {
        number,
        title: v.title,
        type: v.type,
        status: v.status,
        importance: v.importance,
        priorityOverride: null,
        dueAt: due,
        firstDueAt: due,
        startAt: created,
        doneCriteria: v.doneCriteria,
        description: v.description,
        assigneeId: v.assigneeId,
        reporterId: v.reporterId,
        labelIds: v.labelIds,
        occurredOn: v.occurredOn,
        impact: v.impact,
        createdAt: created,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
        importId,
        importedBy: uid,
        // 解決済み・クローズの記録（管理者の取り込みだけ）。日時が分からなければ書かない（集計に混ぜない）
        ...(done ? {
          cause: v.cause, countermeasure: v.countermeasure, causeCategory: v.causeCategory,
          resolvedAssignee: v.assigneeId,
          ...(v.resolvedAt ? { resolvedAt: Timestamp.fromDate(v.resolvedAt) } : {}),
        } : {}),
        ...(v.status === 'closed' ? {
          effect: v.effect, learning: v.learning,
          ...(v.closedAt ? { closedAt: Timestamp.fromDate(v.closedAt) } : {}),
        } : {}),
      });
      tx.set(doc(collection(issueRef, 'events')), { type: 'imported', importId, by: uid, tz, at: serverTimestamp() });
      return number;
    });
  }

  /** 取り込みの取り消し：その回に取り込んだ課題を、まとめて削除フォルダへ（理由つき）。移した件数を返す */
  async undoImport(pid: string, importId: string, reason: string, uid: string, tz: string): Promise<number> {
    const s = await getDocs(query(collection(db, 'projects', pid, 'issues'), where('importId', '==', importId)));
    const targets = s.docs.filter((d) => d.data()['status'] !== 'deleted');
    // 1件につき2つ書く（課題と経緯）。まとめ書きは500件までなので、200件ずつ
    for (let i = 0; i < targets.length; i += 200) {
      const batch = writeBatch(db);
      for (const d of targets.slice(i, i + 200)) {
        const from = d.data()['status'];
        batch.update(d.ref, {
          status: 'deleted', deletedFrom: from, deletedReason: reason, deletedAt: serverTimestamp(), deletedBy: uid,
          updatedAt: serverTimestamp(), updatedBy: uid,
        });
        batch.set(doc(collection(d.ref, 'events')), {
          type: 'status', from, to: 'deleted', reason, by: uid, tz, at: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    return targets.length;
  }

  /** 取り込みを管理ログに残す（追加の取り決め：取り込みは「誰が、いつ」を記録する） */
  logImport(pid: string, count: number, uid: string, role: string) {
    return addDoc(collection(db, 'projects', pid, 'adminLogs'), {
      type: 'import', by: uid, target: uid, from: role, to: null, moved: count, at: serverTimestamp(),
    });
  }

  /** 未クローズの課題を見張る。変わるたびに onData が呼ばれる。戻り値を呼ぶと見張りをやめる */
  watchOpen(pid: string, onData: (issues: Issue[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'), where('status', 'in', OPEN_STATUSES)),
      (s) => onData(s.docs.map(toIssue)),
      onError,
    );
  }
  async get(pid: string, iid: string): Promise<Issue | null> {
    const s = await getDoc(doc(db, 'projects', pid, 'issues', iid));
    return s.exists() ? { ...(s.data() as Omit<Issue, 'id'>), id: s.id } : null;
  }

  /** 1件の課題を見張る。消えた（または読めない）ときは null */
  watchIssue(
    pid: string, iid: string, onData: (issue: Issue | null) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      doc(db, 'projects', pid, 'issues', iid),
      (s) => onData(s.exists() ? toIssue(s) : null),
      onError,
    );
  }

  /** ステータス変更：課題の更新と履歴の追加を同時に行う */
  async changeStatus(pid: string, issue: Issue, t: Transition, p: StatusPayload, uid: string, tz: string) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    const update: Record<string, unknown> = {
      status: t.to,
      statusReason: p.reason,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    };
    if (t.needs === 'resolve') {
      Object.assign(update, {
        cause: p.cause,
        countermeasure: p.countermeasure,
        causeCategory: p.causeCategory,
        doneCriteriaMet: p.doneCriteriaMet,
        resolvedAt: serverTimestamp(),
        // だれが解決したかを残す（あとで担当を替えても、実績は解決した人のまま）
        resolvedAssignee: issue.assigneeId,
      });
      if (p.workaroundEnded) update['workaroundEnded'] = true;
    }
    if (t.needs === 'close') {
      Object.assign(update, {
        effect: p.effect,
        learning: p.learning,
        doneCriteriaMet: p.doneCriteriaMet,
        closedAt: serverTimestamp(),
      });
    }
    // issue は、モーダルを開いた時点（かんばんならつかんだ時点）の課題
    const rule = STATUS_NOTICE[t.key];
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      const notes = rule
        ? await this.prepareNotices(tx, pid, issue, [{
          to: rule.to === 'assignee' ? issue.assigneeId : issue.reporterId, type: rule.type, detail: p.reason,
        }])
        : [];
      tx.update(ref, update);
      tx.set(doc(collection(ref, 'events')), {
        type: 'status', from: issue.status, to: t.to, reason: p.reason, by: uid, tz, at: serverTimestamp(),
      });
      // 解決と一緒に回避策をやめたときは、その中身も経緯に残す（詳細の欄からは消えるため）
      if (p.workaroundEnded) {
        tx.set(doc(collection(ref, 'events')), {
          type: 'edit', fields: ['workaroundEnded'], changes: {}, reason: '',
          by: uid, tz, at: serverTimestamp(),
        });
      }
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /**
   * 入力の要らないステータス変更を、元に戻す。今のステータスが「変えた先」のままのときだけ戻す
   * （ほかの人がもう動かしていたら、上書きせずに UndoConflictError）。お知らせは出さない（赤R）
   * before＝変える前の課題（保留の理由を取り戻すため）
   */
  async undoStatus(pid: string, before: Issue, t: Transition, uid: string, tz: string) {
    const back = TRANSITIONS.find((x) => x.key === UNDO_OF[t.key]);
    const latest = await this.get(pid, before.id);
    if (!back || !latest || latest.status !== t.to) throw new UndoConflictError();
    await this.changeStatus(pid, latest, back,
      { ...EMPTY_STATUS_PAYLOAD, reason: back.needs === 'reason' ? (before.statusReason ?? '') : '' }, uid, tz);
  }

  /**
   * 編集を元に戻す。変えた欄が、今も自分の書いた値のままのときだけ戻す
   * （ほかの人が同じ欄を変えていたら、上書きせずに UndoConflictError）。お知らせは出さない（赤R）
   */
  async undoEdit(
    pid: string, iid: string, applied: IssueEdits, previous: IssueEdits, reason: string, uid: string, tz: string,
  ) {
    const latest = await this.get(pid, iid);
    if (!latest || ['closed', 'merged', 'deleted'].includes(latest.status) || !matchesEdits(latest, applied)) {
      throw new UndoConflictError();
    }
    await this.updateIssue(pid, latest, previous, reason, uid, tz, false);
  }

  /** コメント：書くのと同時に、担当者と提起者に知らせる（今もメンバーの人だけ） */
  addComment(pid: string, iid: string, body: string, uid: string, tz: string) {
    const issueRef = doc(db, 'projects', pid, 'issues', iid);
    return runTransaction(db, async (tx) => {
      const s = await tx.get(issueRef);
      if (!s.exists()) throw new Error('issue-not-found');
      const i = s.data() as Omit<Issue, 'id'>;
      const detail = body.slice(0, 80);
      const notes = await this.prepareNotices(tx, pid, { id: iid, number: i.number, title: i.title }, [
        { to: i.assigneeId, type: 'comment', detail },
        { to: i.reporterId, type: 'comment', detail },
      ]);
      tx.set(doc(collection(issueRef, 'comments')), { body, by: uid, tz, at: serverTimestamp() });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }
  /** コメントを直す（本人のみ。ルールで確認） */
  updateComment(pid: string, iid: string, cid: string, body: string) {
    return updateDoc(doc(db, 'projects', pid, 'issues', iid, 'comments', cid), {
      body,
      editedAt: serverTimestamp(),
    });
  }

  /** コメントを消す。文書は残し、本文を空にして「消した」印を付ける（本人か管理者） */
  deleteComment(pid: string, iid: string, cid: string, uid: string) {
    return updateDoc(doc(db, 'projects', pid, 'issues', iid, 'comments', cid), {
      deleted: true,
      deletedBy: uid,
      deletedAt: serverTimestamp(),
      body: '',
    });
  }

  /** 履歴とコメントを、古い順に1本にまとめる */
  async timeline(pid: string, iid: string): Promise<TimelineItem[]> {
    const base = ['projects', pid, 'issues', iid] as const;
    const [events, comments] = await Promise.all([
      getDocs(query(collection(db, ...base, 'events'), orderBy('at'))),
      getDocs(query(collection(db, ...base, 'comments'), orderBy('at'))),
    ]);
    const items: TimelineItem[] = [
      ...events.docs.map((d) => ({ ...(d.data() as Omit<TimelineItem, 'id' | 'kind'>), id: d.id, kind: 'event' as const })),
      ...comments.docs.map((d) => ({ ...(d.data() as Omit<TimelineItem, 'id' | 'kind'>), id: d.id, kind: 'comment' as const })),
    ];
    return items.sort((a, b) => a.at.toMillis() - b.at.toMillis());
  }

  /** 経緯（履歴とコメント）を見張る。どちらかが変わるたびに、古い順の1本にまとめて渡す */
  watchTimeline(
    pid: string, iid: string, onData: (items: TimelineItem[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    const base = ['projects', pid, 'issues', iid] as const;
    let events: TimelineItem[] | null = null;
    let comments: TimelineItem[] | null = null;
    const toItem = (kind: 'event' | 'comment') => (d: QueryDocumentSnapshot): TimelineItem => ({
      ...(d.data({ serverTimestamps: 'estimate' }) as Omit<TimelineItem, 'id' | 'kind'>), id: d.id, kind,
    });
    // 両方が1回ずつ届いてから渡す（片方だけで画面を作ると、経緯が一瞬欠ける）
    const emit = () => {
      if (events && comments) onData([...events, ...comments].sort((a, b) => a.at.toMillis() - b.at.toMillis()));
    };
    const stopEvents = onSnapshot(query(collection(db, ...base, 'events'), orderBy('at')), (s) => {
      events = s.docs.map(toItem('event'));
      emit();
    }, onError);
    const stopComments = onSnapshot(query(collection(db, ...base, 'comments'), orderBy('at')), (s) => {
      comments = s.docs.map(toItem('comment'));
      emit();
    }, onError);
    // 呼んだ側には、2本まとめてやめる関数を1つだけ返す
    return () => {
      stopEvents();
      stopComments();
    };
  }
  /** 編集：変えた項目だけを更新し、経緯に「何を、何から何へ、なぜ」を残す */
  /** notify＝false のときは通知を出さない（まとめて操作で、まとめて1通にするため） */
  async updateIssue(
    pid: string, issue: Issue, edits: IssueEdits, reason: string, uid: string, tz: string, notify = true,
  ) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    const keys = (Object.keys(edits) as (keyof IssueEdits)[]).filter((k) => edits[k] !== undefined);

    const update: Record<string, unknown> = { updatedAt: serverTimestamp(), updatedBy: uid };
    for (const k of keys) {
      update[k] = k === 'dueAt' ? Timestamp.fromDate(edits.dueAt!) : edits[k];
    }

    const changes: Record<string, unknown> = {};
    if (edits.dueAt) changes['dueAt'] = { from: issue.dueAt, to: Timestamp.fromDate(edits.dueAt) };
    if (edits.assigneeId) changes['assigneeId'] = { from: issue.assigneeId, to: edits.assigneeId };
    if (edits.doneCriteria !== undefined) {
      changes['doneCriteria'] = { from: issue.doneCriteria, to: edits.doneCriteria };
    }

    // 担当者が変わったら新しい担当者に、期限だけ変わったら担当者に知らせる（両方変わっても1通）
    const want: NoticeWant | null = !notify ? null : edits.assigneeId
      ? { to: edits.assigneeId, type: 'assigned', detail: reason }
      : edits.dueAt ? { to: issue.assigneeId, type: 'dueChanged', detail: reason } : null;
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      const notes = want
        ? await this.prepareNotices(tx, pid, { id: issue.id, number: issue.number, title: edits.title ?? issue.title }, [want])
        : [];
      tx.update(ref, update);
      tx.set(doc(collection(ref, 'events')), {
        type: 'edit', fields: keys, changes, reason, by: uid, tz, at: serverTimestamp(),
      });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /** 原因・対策の記入（対応中・保留のとき）。経緯には残すが、通知はしない（軽い編集の扱い） */
  async updateCause(
    pid: string, issue: Issue,
    v: { cause: string; countermeasure: string; causeCategory: CauseCategory | null },
    uid: string, tz: string,
  ) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    // 変わった欄だけを経緯に書く（何も変えていなければ保存しない）
    const fields = [
      (issue.cause ?? '') !== v.cause ? 'cause' : null,
      (issue.countermeasure ?? '') !== v.countermeasure ? 'countermeasure' : null,
      (issue.causeCategory ?? null) !== v.causeCategory ? 'causeCategory' : null,
    ].filter((f): f is string => f !== null);
    if (!fields.length) return;
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      tx.update(ref, { ...v, updatedAt: serverTimestamp(), updatedBy: uid });
      tx.set(doc(collection(ref, 'events')), {
        type: 'edit', fields, changes: {}, reason: '', by: uid, tz, at: serverTimestamp(),
      });
    });
  }

  /** 回避策の記入（未完了のとき）。書き直したら「外した」の印は戻す。経緯には残すが、通知はしない */
  async updateWorkaround(pid: string, issue: Issue, text: string, uid: string, tz: string) {
    if ((issue.workaround ?? '') === text && !issue.workaroundEnded) return;
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      tx.update(ref, { workaround: text, workaroundEnded: false, updatedAt: serverTimestamp(), updatedBy: uid });
      // 書いた回避策の中身も経緯に残す（書き直しの流れを、あとでたどれるように）
      tx.set(doc(collection(ref, 'events')), {
        type: 'edit', fields: ['workaround'], changes: {}, reason: text, by: uid, tz, at: serverTimestamp(),
      });
    });
  }

  /** 回避策をやめる：「適用中」の札を外し、やめた回避策の中身は経緯に残す（詳細の欄からは消えるため） */
  async endWorkaround(pid: string, issue: Issue, uid: string, tz: string) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      tx.update(ref, { workaroundEnded: true, updatedAt: serverTimestamp(), updatedBy: uid });
      tx.set(doc(collection(ref, 'events')), {
        type: 'edit', fields: ['workaroundEnded'], changes: {}, reason: '',
        by: uid, tz, at: serverTimestamp(),
      });
    });
  }  

  /** 優先度の手動変更。value が null なら「自動に戻す」 */
  async setPriority(
    pid: string, issue: Issue, value: Level | null, auto: Level, reason: string, uid: string, tz: string,
  ) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      tx.update(ref, { priorityOverride: value, updatedAt: serverTimestamp(), updatedBy: uid });
      tx.set(doc(collection(ref, 'events')), {
        type: 'priority',
        fromPriority: issue.priorityOverride ?? null,
        toPriority: value,
        autoPriority: auto,
        reason, by: uid, tz, at: serverTimestamp(),
      });
    });
  }

  /**
   * 統合（管理者のみ）：統合元を「統合済み」にし、統合先へのリンクを残す。元に戻せない。
   * 1つのトランザクションで、統合元のステータス・両方の経緯・「重複」の関連課題・通知をまとめて書く
   */
  async mergeIssue(pid: string, issue: Issue, target: Issue, reason: string, uid: string, tz: string) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    const targetRef = doc(db, 'projects', pid, 'issues', target.id);
    const outRef = doc(ref, 'links', relationId('duplicate', 'out', pid, target.id));
    await runTransaction(db, async (tx) => {
      // ---- 読む（全部、書く前に） ----
      await assertUnchanged(tx, ref, issue);
      const t = await tx.get(targetRef);
      if (!t.exists() || !OPEN_STATUSES.includes(t.data()['status'])) throw new Error('merge-target-closed');
      const linked = (await tx.get(outRef)).exists();
      const notes = await this.prepareNotices(tx, pid, issue, [
        { to: issue.assigneeId, type: 'merged', detail: `#${target.number} ${target.title}` },
        { to: issue.reporterId, type: 'merged', detail: `#${target.number} ${target.title}` },
      ]);
      // ---- 書く ----
      tx.update(ref, {
        status: 'merged', statusReason: reason, mergedInto: { iid: target.id, number: target.number },
        updatedAt: serverTimestamp(), updatedBy: uid,
      });
      tx.set(doc(collection(ref, 'events')), {
        type: 'status', from: issue.status, to: 'merged', reason, by: uid, tz, at: serverTimestamp(),
      });
      tx.set(doc(collection(targetRef, 'events')), {
        type: 'merge', merged: { iid: issue.id, number: issue.number }, reason, by: uid, tz, at: serverTimestamp(),
      });
      // 「重複」でつなぐ（もうつながっていれば、そのまま）
      if (!linked) {
        tx.set(outRef, { kind: 'duplicate', dir: 'out', pid, iid: target.id, by: uid, at: serverTimestamp() });
        tx.set(doc(targetRef, 'links', relationId('duplicate', 'in', pid, issue.id)),
          { kind: 'duplicate', dir: 'in', pid, iid: issue.id, by: uid, at: serverTimestamp() });
      }
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /** 削除：削除フォルダへ移す（管理者のみ。ルールで確認）。元のステータスは deletedFrom に残す */
  async deleteIssue(pid: string, issue: Issue, reason: string, uid: string, tz: string) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    await runTransaction(db, async (tx) => {
      await assertUnchanged(tx, ref, issue);
      tx.update(ref, {
        status: 'deleted',
        deletedFrom: issue.status,
        deletedReason: reason,
        deletedAt: serverTimestamp(),
        deletedBy: uid,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      });
      tx.set(doc(collection(ref, 'events')), {
        type: 'status', from: issue.status, to: 'deleted', reason, by: uid, tz, at: serverTimestamp(),
      });
    });
  }

  /** 復元：削除する前のステータスに戻す（管理者か、提起した本人。ルールで確認） */
  /** adminIds：知らせる管理者（メンバーが復元したときだけ渡す。管理者が戻したときは空） */
  async restoreIssue(pid: string, iid: string, uid: string, tz: string, adminIds: string[] = []) {
    const ref = doc(db, 'projects', pid, 'issues', iid);
    await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists()) throw new Error('issue-not-found');
      const latest = { ...(s.data() as Omit<Issue, 'id'>), id: s.id };
      // ほかの人がもう復元していたら、何もしない
      if (latest.status !== 'deleted') throw new ConflictError(latest);
      const to = latest.deletedFrom ?? 'open';
      const notes = await this.prepareNotices(tx, pid, latest,
        adminIds.map((a): NoticeWant => ({ to: a, type: 'restored' })));
      tx.update(ref, {
        status: to,
        deletedFrom: deleteField(),
        deletedReason: deleteField(),
        deletedAt: deleteField(),
        deletedBy: deleteField(),
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      });
      tx.set(doc(collection(ref, 'events')), {
        type: 'status', from: 'deleted', to, by: uid, tz, at: serverTimestamp(),
      });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }
  /**
   * 関連課題を付ける。こちら（out）と相手側の写し（in）を1つのバッチで書く（片方だけにならない）。
   * 経緯はこの課題に残す。相手が同じプロジェクトなら、相手の経緯にも残す（別のプロジェクトは書けないことがあるため）
   */
  async addLink(
    pid: string, iid: string, hereNumber: number, kind: LinkKind,
    to: { pid: string; iid: string; number: number }, uid: string, tz: string,
  ) {
    const here = doc(db, 'projects', pid, 'issues', iid);
    const there = doc(db, 'projects', to.pid, 'issues', to.iid);
    const batch = writeBatch(db);
    batch.set(doc(here, 'links', relationId(kind, 'out', to.pid, to.iid)),
      { kind, dir: 'out', pid: to.pid, iid: to.iid, by: uid, at: serverTimestamp() });
    batch.set(doc(there, 'links', relationId(kind, 'in', pid, iid)),
      { kind, dir: 'in', pid, iid, by: uid, at: serverTimestamp() });
    batch.set(doc(collection(here, 'events')), {
      type: 'link', link: { action: 'add', kind, dir: 'out', pid: to.pid, iid: to.iid, number: to.number },
      by: uid, tz, at: serverTimestamp(),
    });
    if (to.pid === pid) {
      batch.set(doc(collection(there, 'events')), {
        type: 'link', link: { action: 'add', kind, dir: 'in', pid, iid, number: hereNumber },
        by: uid, tz, at: serverTimestamp(),
      });
    }
    await batch.commit();
  }

  /** 関連課題を外す。こちらの1枚と、相手側の対の1枚を一緒に消す。otherNumber は相手の番号（わからなければ null） */
  async removeLink(
    pid: string, iid: string, hereNumber: number, rel: IssueRelation, otherNumber: number | null,
    uid: string, tz: string,
  ) {
    const here = doc(db, 'projects', pid, 'issues', iid);
    const there = doc(db, 'projects', rel.pid, 'issues', rel.iid);
    const pairDir = rel.dir === 'out' ? 'in' : 'out';
    const write = (withPair: boolean) => {
      const batch = writeBatch(db);
      batch.delete(doc(here, 'links', rel.id));
      if (withPair) batch.delete(doc(there, 'links', relationId(rel.kind, pairDir, pid, iid)));
      batch.set(doc(collection(here, 'events')), {
        type: 'link',
        link: { action: 'remove', kind: rel.kind, dir: rel.dir, pid: rel.pid, iid: rel.iid, number: otherNumber },
        by: uid, tz, at: serverTimestamp(),
      });
      if (withPair && rel.pid === pid) {
        batch.set(doc(collection(there, 'events')), {
          type: 'link', link: { action: 'remove', kind: rel.kind, dir: pairDir, pid, iid, number: hereNumber },
          by: uid, tz, at: serverTimestamp(),
        });
      }
      return batch.commit();
    };
    try {
      await write(true);
    } catch (e) {
      // 相手の課題が完全削除されていると、対の1枚はもう無く、消そうとするとルールに断られる。
      // そのときは、こちらの1枚だけを消す（ルールは「対が無いこと」を見るので通る）
      if ((e as { code?: string }).code !== 'permission-denied') throw e;
      await write(false);
    }
  }
  /** この課題の関連課題（こちらから付けたもの・相手から付けられたもの）を見張る */
  watchLinks(
    pid: string, iid: string, onData: (rels: IssueRelation[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      collection(db, 'projects', pid, 'issues', iid, 'links'),
      (s) => onData(s.docs.map((d) => ({
        ...(d.data({ serverTimestamps: 'estimate' }) as Omit<IssueRelation, 'id'>), id: d.id,
      }))),
      onError,
    );
  }

  // ---- サブタスク ----

  private subtaskCol(pid: string, iid: string) {
    return collection(db, 'projects', pid, 'issues', iid, 'subtasks');
  }

  /** この課題のサブタスクを見張る（並び順どおり） */
  watchSubtasks(
    pid: string, iid: string, onData: (list: Subtask[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      this.subtaskCol(pid, iid),
      (s) => onData(s.docs
        .map((d) => ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Subtask, 'id'>), id: d.id }))
        .sort((a, b) => a.order - b.order)),
      onError,
    );
  }

  /** サブタスクを1回だけ読む（解決のモーダルの注意に使う。見張るほどではないため） */
  async listSubtasks(pid: string, iid: string): Promise<Subtask[]> {
    const s = await getDocs(this.subtaskCol(pid, iid));
    return s.docs.map((d) => ({ ...(d.data() as Omit<Subtask, 'id'>), id: d.id }));
  }

  /** サブタスクを1件読む（切り出しの雛形に使う） */
  async getSubtask(pid: string, iid: string, sid: string): Promise<Subtask | null> {
    const s = await getDoc(doc(this.subtaskCol(pid, iid), sid));
    return s.exists() ? { ...(s.data() as Omit<Subtask, 'id'>), id: s.id } : null;
  }

  /**
   * サブタスクを足す。経緯に「足した」を残し、担当者が自分以外なら知らせる（同じ封筒で）。
   * 宛先が今もメンバーかを読んでから書くので、トランザクションにする
   */
  async addSubtask(pid: string, issue: Issue, v: NewSubtask, uid: string, tz: string) {
    const issueRef = doc(db, 'projects', pid, 'issues', issue.id);
    const ref = doc(this.subtaskCol(pid, issue.id));
    await runTransaction(db, async (tx) => {
      const notes = await this.prepareNotices(tx, pid, issue,
        [{ to: v.assigneeId, type: 'subtaskAssigned', detail: v.title }]);
      tx.set(ref, {
        title: v.title, assigneeId: v.assigneeId, dueAt: v.dueAt ? Timestamp.fromDate(v.dueAt) : null,
        status: 'todo', memo: '', order: v.order,
        createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: uid,
      });
      tx.set(doc(collection(issueRef, 'events')), {
        type: 'subtask', sub: { action: 'add', title: v.title }, by: uid, tz, at: serverTimestamp(),
      });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /** サブタスクを直す（変えた欄だけ）。担当者を自分以外に替えたら、新しい担当者に知らせる。経緯には残さない */
  async updateSubtask(pid: string, issue: Issue, sub: Subtask, edits: SubtaskEdits, uid: string) {
    const ref = doc(this.subtaskCol(pid, issue.id), sub.id);
    const update: Record<string, unknown> = { updatedAt: serverTimestamp(), updatedBy: uid };
    if (edits.title !== undefined) update['title'] = edits.title;
    if (edits.memo !== undefined) update['memo'] = edits.memo;
    if (edits.assigneeId !== undefined) update['assigneeId'] = edits.assigneeId;
    if (edits.dueAt !== undefined) update['dueAt'] = edits.dueAt ? Timestamp.fromDate(edits.dueAt) : null;
    const to = edits.assigneeId !== undefined && edits.assigneeId !== sub.assigneeId ? edits.assigneeId : null;
    await runTransaction(db, async (tx) => {
      const notes = to
        ? await this.prepareNotices(tx, pid, issue, [{ to, type: 'subtaskAssigned', detail: edits.title ?? sub.title }])
        : [];
      tx.update(ref, update);
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /** □ と「対応中にする」。読む必要も知らせもないので、1つ書くだけ（サブタスクの担当者もここを通る） */
  setSubtaskStatus(pid: string, iid: string, sid: string, status: SubtaskStatus, uid: string) {
    return updateDoc(doc(this.subtaskCol(pid, iid), sid), { status, updatedAt: serverTimestamp(), updatedBy: uid });
  }

  /** 並べ替え：動かした1件の order だけを書く（前後の真ん中の数は、画面が計算して渡す） */
  moveSubtask(pid: string, iid: string, sid: string, order: number, uid: string) {
    return updateDoc(doc(this.subtaskCol(pid, iid), sid), { order, updatedAt: serverTimestamp(), updatedBy: uid });
  }

  /** サブタスクを消す。経緯に「消した」を残す（消すのと同じ封筒で） */
  async deleteSubtask(pid: string, iid: string, sub: Subtask, uid: string, tz: string) {
    const issueRef = doc(db, 'projects', pid, 'issues', iid);
    const batch = writeBatch(db);
    batch.delete(doc(this.subtaskCol(pid, iid), sub.id));
    batch.set(doc(collection(issueRef, 'events')), {
      type: 'subtask', sub: { action: 'remove', title: sub.title }, by: uid, tz, at: serverTimestamp(),
    });
    await batch.commit();
  }  

  /** この課題を元にして作られた課題（再発防止など）を見張る。削除フォルダのものは出さない */
  watchRelatedTo(
    pid: string, iid: string, onData: (issues: Issue[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'), where('relatedFrom.iid', '==', iid)),
      (s) => onData(s.docs.map(toIssue).filter((i) => i.status !== 'deleted').sort((a, b) => a.number - b.number)),
      onError,
    );
  }

  /** 削除フォルダの課題を見張る（削除した日時の新しい順） */
  watchDeleted(pid: string, onData: (issues: Issue[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'), where('status', '==', 'deleted')),
      (s) => onData(s.docs.map(toIssue)
        .sort((a, b) => (b.deletedAt?.toMillis() ?? 0) - (a.deletedAt?.toMillis() ?? 0))),
      onError,
    );
  }

  /** 完全削除：経緯とコメントを消してから、課題を消す（管理者のみ。削除フォルダの中だけ。元に戻せない） */
  async purgeIssue(pid: string, iid: string) {
    const ref = doc(db, 'projects', pid, 'issues', iid);
    const [events, comments, links, subtasks] = await Promise.all([
      getDocs(collection(ref, 'events')),
      getDocs(collection(ref, 'comments')),
      getDocs(collection(ref, 'links')),
      getDocs(collection(ref, 'subtasks')),
    ]);
    const children = [...events.docs, ...comments.docs, ...links.docs, ...subtasks.docs].map((d) => d.ref);
    // まとめ書きは1回500件まで。余裕をみて400件ずつ
    for (let i = 0; i < children.length; i += 400) {
      const batch = writeBatch(db);
      children.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }

    // 相手側に残った対の1枚も、消せるものは消す（相手のプロジェクトに書けないときは残る。
    // 残っても、相手の画面では「閲覧できない課題」と出て、✕で外せる）
    await Promise.allSettled(links.docs.map((d) => {
      const r = d.data() as Omit<IssueRelation, 'id'>;
      const pairDir = r.dir === 'out' ? 'in' : 'out';
      return deleteDoc(doc(db, 'projects', r.pid, 'issues', r.iid, 'links', relationId(r.kind, pairDir, pid, iid)));
    }));
    // 親は最後に消す。子のルールは「親が削除フォルダにあるか」を見ているので、親が先に消えると子を消せなくなる
    await deleteDoc(ref);
  }

  /** クローズ・却下も含めたすべての課題（検索と「すべて」表示のときだけ使う） */
  async listAll(pid: string): Promise<Issue[]> {
    const s = await getDocs(collection(db, 'projects', pid, 'issues'));
    return s.docs.map((d) => ({ ...(d.data() as Omit<Issue, 'id'>), id: d.id }));
  }


  /**
   * 1つのプロジェクトで、自分が担当している課題と、自分がサブタスクを担当している課題を見張る
   * （ホームの「自分の課題」用。プロジェクトごとに1本）。
   * コレクショングループでまとめて探すと、ルールで「そのプロジェクトのメンバーか」を確かめられないため
   */
  watchMyIssuesIn(
    pid: string, uid: string,
    onData: (issues: (Issue & { projectId: string })[]) => void,
    onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'),
        or(where('assigneeId', '==', uid), where('subtaskAssignees', 'array-contains', uid))),
      (s) => onData(s.docs.map((d) => ({ ...toIssue(d), projectId: pid }))),
      onError,
    );
  }

  /** 直近 days 日以内にクローズした課題を見張る（かんばんの「完了」の列用） */
  watchRecentlyClosed(
    pid: string, days: number, onData: (issues: Issue[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    const since = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'), where('closedAt', '>=', since)),
      // 再開した課題は closedAt が残っているので、今クローズのものだけにする
      (s) => onData(s.docs.map(toIssue).filter((i) => i.status === 'closed')),
      onError,
    );
  }
}