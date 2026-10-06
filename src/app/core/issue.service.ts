import { Injectable } from '@angular/core';
import {
  Timestamp, collection, doc, getDocs, query, runTransaction, serverTimestamp, where,
} from 'firebase/firestore';
import { db } from './firebase';
import { Issue, IssueType, Level, OPEN_STATUSES } from './models';

export interface NewIssue {
  title: string;
  type: IssueType;
  importance: Level;
  dueAt: Date;
  assigneeId: string;
  doneCriteria: string;
  description: string;
}

@Injectable({ providedIn: 'root' })
export class IssueService {
  /** 課題番号の採番と、課題・履歴の作成を、1つのトランザクションで行う */
  create(pid: string, input: NewIssue, uid: string): Promise<number> {
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
      tx.set(doc(collection(issueRef, 'events')), { type: 'created', by: uid, at: serverTimestamp() });
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
}