import { Injectable } from '@angular/core';
import {
    FirestoreError, Timestamp, Unsubscribe, collection, deleteDoc, doc, onSnapshot, query, serverTimestamp, setDoc, where,
  } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Issue, Reminder, Subtask } from '../models';

/** 課題のリマインド（自分だけ）。置く・変える・外す・見張る */
@Injectable({ providedIn: 'root' })
export class ReminderService {
  /** 文書の名前：課題は「pid_iid」、サブタスクは「pid_iid_sid」。1つに1つ。置き直すと上書きになる */
  private ref(pid: string, iid: string, sid?: string | null) {
    return doc(db, 'users', auth.currentUser!.uid, 'reminders', sid ? `${pid}_${iid}_${sid}` : `${pid}_${iid}`);
  }

  /** この課題の、自分のリマインドを見張る（なければ null。届いて関数が消したら、null が届く） */
  watch(pid: string, iid: string, onData: (r: Reminder | null) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(this.ref(pid, iid),
      (s) => onData(s.exists() ? { ...(s.data() as Omit<Reminder, 'id'>), id: s.id } : null), onError);
  }

  /** この課題の、サブタスクに置いた自分のリマインドを見張る（sid → リマインド） */
  watchSubtasks(pid: string, iid: string, onData: (m: Map<string, Reminder>) => void,
    onError: (e: FirestoreError) => void): Unsubscribe {
    const q = query(collection(db, 'users', auth.currentUser!.uid, 'reminders'),
      where('pid', '==', pid), where('iid', '==', iid));
    return onSnapshot(q, (s) => {
      const m = new Map<string, Reminder>();
      for (const d of s.docs) {
        const r = { ...(d.data() as Omit<Reminder, 'id'>), id: d.id };
        if (r.sid) m.set(r.sid, r);
      }
      onData(m);
    }, onError);
  }

  /** 置く（sub を渡すと、そのサブタスクのリマインド） */
  set(pid: string, issue: Issue, projectName: string, at: Date, sub: Subtask | null = null) {
    return setDoc(this.ref(pid, issue.id, sub?.id), {
      pid, iid: issue.id, number: issue.number, title: issue.title.slice(0, 200),
      projectName: projectName.slice(0, 100), at: Timestamp.fromDate(at), createdAt: serverTimestamp(),
      ...(sub ? { sid: sub.id, subTitle: sub.title.slice(0, 200) } : {}),
    });
  }

  remove(pid: string, iid: string, sid: string | null = null) {
    return deleteDoc(this.ref(pid, iid, sid));
  }
}