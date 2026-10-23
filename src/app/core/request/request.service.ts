import { Injectable, inject } from '@angular/core';
import {
  FirestoreError, QueryDocumentSnapshot, Transaction, Unsubscribe, collection, doc, onSnapshot, query,
  runTransaction, serverTimestamp, updateDoc, where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { NotificationService } from '../notification/notification.service';
import { Issue, IssueRequest, NotificationType, RequestKind } from '../models';

const toRequest = (d: QueryDocumentSnapshot): IssueRequest =>
  ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<IssueRequest, 'id'>), id: d.id });

/** 依頼（削除・統合・再開）。メンバーが管理者に頼み、管理者が対応するか見送る */
@Injectable({ providedIn: 'root' })
export class RequestService {
  private notifications = inject(NotificationService);

  private col(pid: string) {
    return collection(db, 'projects', pid, 'requests');
  }

  /**
   * 宛先のうち、今もメンバーの人にだけ通知を用意する（トランザクションの中で、書く前に呼ぶ）。
   * 抜けた人を宛先にすると、ルールで断られて保存ごと失敗するため（IssueService の prepareNotices と同じ考え方）
   */
  private async notices(
    tx: Transaction, pid: string, about: { iid: string; number: number; title: string },
    tos: string[], type: NotificationType, detail: string,
  ) {
    const targets = [...new Set(tos)];
    const [project, ...members] = await Promise.all([
      tx.get(doc(db, 'projects', pid)),
      ...targets.map((u) => tx.get(doc(db, 'projects', pid, 'members', u))),
    ]);
    const a = {
      pid, projectName: project.data()?.['name'] ?? '', iid: about.iid, issueNumber: about.number, issueTitle: about.title,
    };
    return targets
      .filter((_, i) => members[i].exists())
      .map((to) => this.notifications.notice(to, type, a, detail))
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }

  /**
   * 依頼を出す（メンバー）。管理者全員に知らせる（依頼と同じ封筒で）。
   * 番号・題名・名前の写しは、書く直前の課題と自分のメンバー文書から取る
   * （ルールが「今の値と同じか」を確かめるため。画面が持っている課題は、ほかの人が直した直後だと古いことがある）
   */
  async create(
    pid: string, issue: Issue, kind: RequestKind, reason: string,
    target: { iid: string; number: number } | null, adminIds: string[],
  ) {
    const uid = auth.currentUser!.uid;
    const ref = doc(this.col(pid));
    await runTransaction(db, async (tx) => {
      // 読むのが先、書くのが後（notices の中でも読むので、その前に）
      const [cur, me] = await Promise.all([
        tx.get(doc(db, 'projects', pid, 'issues', issue.id)),
        tx.get(doc(db, 'projects', pid, 'members', uid)),
      ]);
      const i = cur.data();
      if (!i) throw new Error('issue-gone');
      const about = { iid: issue.id, number: i['number'] as number, title: i['title'] as string };
      const notes = await this.notices(tx, pid, about, adminIds, 'request', reason);
      tx.set(ref, {
        kind, iid: issue.id, number: about.number, title: about.title,
        targetIid: target?.iid ?? null, targetNumber: target?.number ?? null,
        reason, by: uid, byName: (me.data()?.['displayName'] ?? '') as string, at: serverTimestamp(), status: 'open',
      });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }

  /** このプロジェクトの、対応待ちの依頼（新しい順）。管理者の一覧とメニューの件数に使う */
  watchOpen(pid: string, onData: (list: IssueRequest[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(query(this.col(pid), where('status', '==', 'open')),
      (s) => onData(s.docs.map(toRequest).sort((a, b) => b.at.toMillis() - a.at.toMillis())), onError);
  }

  /** この課題の、対応待ちの依頼（課題の上の箱に使う） */
  watchOpenFor(
    pid: string, iid: string, onData: (list: IssueRequest[]) => void, onError: (e: FirestoreError) => void,
  ): Unsubscribe {
    return onSnapshot(query(this.col(pid), where('iid', '==', iid), where('status', '==', 'open')),
      (s) => onData(s.docs.map(toRequest)), onError);
  }

  /** 取り下げる（依頼した本人） */
  cancel(pid: string, rid: string) {
    return updateDoc(doc(this.col(pid), rid), { status: 'cancelled' });
  }

  /** 対応済みにする（管理者が、いつもの窓で削除・統合・再開をしたあと）。依頼した人に知らせる */
  markDone(pid: string, req: IssueRequest) {
    return this.handle(pid, req, 'done', '');
  }

  /** 見送る（管理者）。一言は任意。依頼した人に知らせる */
  decline(pid: string, req: IssueRequest, note: string) {
    return this.handle(pid, req, 'declined', note);
  }

  /** 対応済み・見送りの共通。もう対応されていたら（ほかの管理者が先に）、何もしない */
  private async handle(pid: string, req: IssueRequest, status: 'done' | 'declined', note: string) {
    const ref = doc(this.col(pid), req.id);
    await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists() || s.data()['status'] !== 'open') return;
      const notes = await this.notices(tx, pid, req, [req.by],
        status === 'done' ? 'requestDone' : 'requestDeclined', note);
      tx.update(ref, {
        status, handledBy: auth.currentUser!.uid, handledAt: serverTimestamp(), ...(note ? { note } : {}),
      });
      notes.forEach((n) => tx.set(n.ref, n.data));
    });
  }
}