import { Injectable } from '@angular/core';
import {
  FirestoreError, QueryDocumentSnapshot, Timestamp, Unsubscribe, collection, collectionGroup, doc, getDoc, getDocs,
  onSnapshot, orderBy, query, runTransaction, serverTimestamp, where, writeBatch, addDoc, updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  CauseCategory, Effect, Issue, IssueType, Level, OPEN_STATUSES, TimelineItem,
} from './models';
import { Transition } from './workflow';

/** 見張りで届いた文書を課題にする。保存直後の手元の版では、サーバーの時刻が null なので仮の時刻を入れる */
function toIssue(d: QueryDocumentSnapshot): Issue {
  return { ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Issue, 'id'>), id: d.id };
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
}

@Injectable({ providedIn: 'root' })
export class IssueService {
  /** 課題番号の採番と、課題・履歴の作成を、1つのトランザクションで行う */
  create(pid: string, input: NewIssue, uid: string, tz: string): Promise<number> {
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
        startAt: serverTimestamp(),
        doneCriteria: input.doneCriteria,
        description: input.description,
        assigneeId: input.assigneeId,
        reporterId: uid,
        labelIds: input.labelIds,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      tx.set(doc(collection(issueRef, 'events')), { type: 'created', by: uid, tz, at: serverTimestamp() });
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
    const batch = writeBatch(db);
    batch.update(ref, update);
    batch.set(doc(collection(ref, 'events')), {
      type: 'status', from: issue.status, to: t.to, reason: p.reason, by: uid, tz, at: serverTimestamp(),
    });
    await batch.commit();
  }

  addComment(pid: string, iid: string, body: string, uid: string, tz: string) {
    return addDoc(collection(db, 'projects', pid, 'issues', iid, 'comments'), {
      body, by: uid, tz, at: serverTimestamp(),
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

    const update: Record<string, unknown> = { updatedAt: serverTimestamp() };
    for (const k of keys) {
      update[k] = k === 'dueAt' ? Timestamp.fromDate(edits.dueAt!) : edits[k];
    }

    const changes: Record<string, unknown> = {};
    if (edits.dueAt) changes['dueAt'] = { from: issue.dueAt, to: Timestamp.fromDate(edits.dueAt) };
    if (edits.assigneeId) changes['assigneeId'] = { from: issue.assigneeId, to: edits.assigneeId };
    if (edits.doneCriteria !== undefined) {
      changes['doneCriteria'] = { from: issue.doneCriteria, to: edits.doneCriteria };
    }

    const batch = writeBatch(db);
    batch.update(ref, update);
    batch.set(doc(collection(ref, 'events')), {
      type: 'edit', fields: keys, changes, reason, by: uid, tz, at: serverTimestamp(),
    });
    await batch.commit();
  }

  /** 優先度の手動変更。value が null なら「自動に戻す」 */
  async setPriority(
    pid: string, issue: Issue, value: Level | null, auto: Level, reason: string, uid: string, tz: string,
  ) {
    const ref = doc(db, 'projects', pid, 'issues', issue.id);
    const batch = writeBatch(db);
    batch.update(ref, { priorityOverride: value, updatedAt: serverTimestamp() });
    batch.set(doc(collection(ref, 'events')), {
      type: 'priority',
      fromPriority: issue.priorityOverride ?? null,
      toPriority: value,
      autoPriority: auto,
      reason, by: uid, tz, at: serverTimestamp(),
    });
    await batch.commit();
  }

  /** クローズ・却下も含めたすべての課題（検索と「すべて」表示のときだけ使う） */
  async listAll(pid: string): Promise<Issue[]> {
    const s = await getDocs(collection(db, 'projects', pid, 'issues'));
    return s.docs.map((d) => ({ ...(d.data() as Omit<Issue, 'id'>), id: d.id }));
  }

  /** 所属するすべてのプロジェクトで、自分が担当している課題 */
  async listMine(uid: string): Promise<(Issue & { projectId: string })[]> {
    const s = await getDocs(query(collectionGroup(db, 'issues'), where('assigneeId', '==', uid)));
    return s.docs.map((d) => ({
      ...(d.data() as Omit<Issue, 'id'>),
      id: d.id,
      projectId: d.ref.parent.parent!.id,
    }));
  }

  /** 所属するすべてのプロジェクトで、自分が担当している課題を見張る */
  watchMine(
    uid: string,
    onData: (issues: (Issue & { projectId: string })[]) => void,
    onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(
      query(collectionGroup(db, 'issues'), where('assigneeId', '==', uid)),
      (s) => onData(s.docs.map((d) => ({ ...toIssue(d), projectId: d.ref.parent.parent!.id }))),
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