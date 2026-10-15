import { Injectable, inject } from '@angular/core';
import { NoticeAbout, NotificationService } from '../notification/notification.service';
import {
  DocumentReference, FirestoreError, QueryDocumentSnapshot, Timestamp, Transaction, Unsubscribe, collection,
  doc, getDoc, getDocs, onSnapshot, orderBy, query, runTransaction, serverTimestamp, where,
  addDoc, updateDoc, deleteField, deleteDoc, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  CauseCategory, Effect, Issue, IssueLink, IssueType, Level, Member, NotificationType, OPEN_STATUSES, TimelineItem,
} from '../models';
import { Transition, TransitionKey } from './workflow';

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
}

export interface StatusPayload {
  reason: string;
  cause: string;
  countermeasure: string;
  causeCategory: CauseCategory | null;
  effect: Effect | null;
  learning: string;
  doneCriteriaMet: boolean;
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
      if (memoId) tx.delete(doc(db, 'users', uid, 'inbox', memoId));
      // 担当者が自分以外なら、担当者に知らせる（自分のときは notice が null を返す）
      const n = this.notifications.notice(input.assigneeId, 'assigned', {
        pid, projectName: project.data()!['name'], iid: issueRef.id, issueNumber: number, issueTitle: input.title,
      });
      if (n) tx.set(n.ref, n.data);
      return number;
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
      });
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
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
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
  async updateIssue(pid: string, issue: Issue, edits: IssueEdits, reason: string, uid: string, tz: string) {
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
    const want: NoticeWant | null = edits.assigneeId
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
    const [events, comments] = await Promise.all([
      getDocs(collection(ref, 'events')),
      getDocs(collection(ref, 'comments')),
    ]);
    const children = [...events.docs, ...comments.docs].map((d) => d.ref);
    // まとめ書きは1回500件まで。余裕をみて400件ずつ
    for (let i = 0; i < children.length; i += 400) {
      const batch = writeBatch(db);
      children.slice(i, i + 400).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    // 親は最後に消す。子のルールは「親が削除フォルダにあるか」を見ているので、親が先に消えると子を消せなくなる
    await deleteDoc(ref);
  }

  /** クローズ・却下も含めたすべての課題（検索と「すべて」表示のときだけ使う） */
  async listAll(pid: string): Promise<Issue[]> {
    const s = await getDocs(collection(db, 'projects', pid, 'issues'));
    return s.docs.map((d) => ({ ...(d.data() as Omit<Issue, 'id'>), id: d.id }));
  }


  /**
   * 1つのプロジェクトで、自分が担当している課題を見張る（ホームの「自分の課題」用。プロジェクトごとに1本）。
   * コレクショングループでまとめて探すと、ルールで「そのプロジェクトのメンバーか」を確かめられないため
   */
  watchMyIssuesIn(
    pid: string, uid: string,
    onData: (issues: (Issue & { projectId: string })[]) => void,
    onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      query(collection(db, 'projects', pid, 'issues'), where('assigneeId', '==', uid)),
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