import { Injectable } from '@angular/core';
import {
  Timestamp, collection, doc, getDoc, getDocs, orderBy, query, runTransaction,
  serverTimestamp, where, writeBatch, addDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  CauseCategory, Effect, Issue, IssueType, Level, OPEN_STATUSES, TimelineItem,
} from './models';
import { Transition } from './workflow';

export interface NewIssue {
  title: string;
  type: IssueType;
  importance: Level;
  dueAt: Date;
  assigneeId: string;
  doneCriteria: string;
  description: string;
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
        labelIds: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      tx.set(doc(collection(issueRef, 'events')), { type: 'created', by: uid, tz, at: serverTimestamp() });
      return number;
    });
  }

  /** 未クローズの課題（クローズ・却下以外） */
  async listOpen(pid: string): Promise<Issue[]> {
    const s = await getDocs(
      query(collection(db, 'projects', pid, 'issues'), where('status', 'in', OPEN_STATUSES)),
    );
    return s.docs.map((d) => ({ ...(d.data() as Omit<Issue, 'id'>), id: d.id }));
  }
  async get(pid: string, iid: string): Promise<Issue | null> {
    const s = await getDoc(doc(db, 'projects', pid, 'issues', iid));
    return s.exists() ? { ...(s.data() as Omit<Issue, 'id'>), id: s.id } : null;
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
}