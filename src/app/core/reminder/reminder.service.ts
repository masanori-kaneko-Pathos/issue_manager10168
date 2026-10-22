import { Injectable } from '@angular/core';
import {
  FirestoreError, Timestamp, Unsubscribe, addDoc, collection, deleteDoc, deleteField, doc, onSnapshot, query,
  serverTimestamp, setDoc, updateDoc, where,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { REMINDER_KEEP_DAYS, Reminder } from '../models';

const DAY = 24 * 60 * 60 * 1000;

/** 課題・サブタスクのリマインドの「どれに置くか」（写しに使う値も一緒に） */
export interface ReminderTarget {
  pid: string;
  iid: string;
  number: number;
  title: string;        // 課題名
  projectName: string;
  sid?: string;         // サブタスクのときだけ
  subTitle?: string;    // サブタスク名
}

/** 課題は「pid_iid」、サブタスクは「pid_iid_sid」（1つに1つ。置き直すと上書き） */
export function targetRid(t: ReminderTarget) {
  return t.sid ? `${t.pid}_${t.iid}_${t.sid}` : `${t.pid}_${t.iid}`;
}

/** リマインドから、置いた先を取り出す（自由入力なら null） */
export function targetOf(r: Reminder): ReminderTarget | null {
  if (!r.pid || !r.iid) return null;
  return {
    pid: r.pid, iid: r.iid, number: r.number ?? 0, title: r.title, projectName: r.projectName ?? '',
    ...(r.sid ? { sid: r.sid, subTitle: r.subTitle ?? '' } : {}),
  };
}

/** リマインド（自分だけ）。置く・変える・完了・外す・見張る */
@Injectable({ providedIn: 'root' })
export class ReminderService {
  private col() {
    return collection(db, 'users', auth.currentUser!.uid, 'reminders');
  }

  private refById(id: string) {
    return doc(this.col(), id);
  }

  /** この課題の、自分のリマインドを見張る（なければ null） */
  watch(pid: string, iid: string, onData: (r: Reminder | null) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(this.refById(`${pid}_${iid}`),
      (s) => onData(s.exists() ? { ...(s.data() as Omit<Reminder, 'id'>), id: s.id } : null), onError);
  }

  /** この課題の、サブタスクに置いた自分のリマインドを見張る（sid → リマインド） */
  watchSubtasks(pid: string, iid: string, onData: (m: Map<string, Reminder>) => void,
    onError: (e: FirestoreError) => void): Unsubscribe {
    const q = query(this.col(), where('pid', '==', pid), where('iid', '==', iid));
    return onSnapshot(q, (s) => {
      const m = new Map<string, Reminder>();
      for (const d of s.docs) {
        const r = { ...(d.data() as Omit<Reminder, 'id'>), id: d.id };
        if (r.sid) m.set(r.sid, r);
      }
      onData(m);
    }, onError);
  }

  /**
   * 自分のリマインドを全部見張る（課題・サブタスク・自由入力、届いたもの・完了済みも）。
   * 完了にした直後の手元の版では doneAt が null になるので、estimate で読む
   */
  watchAll(uid: string, onData: (list: Reminder[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(collection(db, 'users', uid, 'reminders'),
      (s) => onData(s.docs.map((d) =>
        ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<Reminder, 'id'>), id: d.id }))),
      onError);
  }

  /**
   * 課題・サブタスクに置く・置き直す。setDoc は丸ごと書き直すので、
   * 前の firedAt・doneAt・expireAt は自然に消える（置き直し＝予定に戻る）
   */
  set(t: ReminderTarget, at: Date) {
    return setDoc(this.refById(targetRid(t)), {
      pid: t.pid, iid: t.iid, number: t.number, title: t.title.slice(0, 200),
      projectName: t.projectName.slice(0, 100), at: Timestamp.fromDate(at), createdAt: serverTimestamp(),
      pending: true,
      ...(t.sid ? { sid: t.sid, subTitle: (t.subTitle ?? '').slice(0, 200) } : {}),
    });
  }

  /** 自由入力を作る（名前は自動。_ を含まない） */
  addFree(title: string, at: Date) {
    return addDoc(this.col(), {
      title: title.slice(0, 200), at: Timestamp.fromDate(at), createdAt: serverTimestamp(), pending: true,
    });
  }

  /**
   * 自由入力を直す。at を渡したとき（時刻を変えたとき）だけ予定に戻す（届いたもの・完了済みでも、もう一度届く）。
   * 題名だけなら、届いた・完了の状態はそのまま
   */
  updateFree(id: string, title: string, at: Date | null) {
    return updateDoc(this.refById(id), at
      ? {
        title: title.slice(0, 200), at: Timestamp.fromDate(at), pending: true,
        firedAt: deleteField(), doneAt: deleteField(), expireAt: deleteField(),
      }
      : { title: title.slice(0, 200) });
  }

  /**
   * 完了にする・戻す。完了にしたものは30日後に自動で消える（TTL）。
   * 戻すときは、まだ届いていなくて時刻が先なら予定に戻す（もう一度届く）。届いたものは「届いたもの」に戻る
   */
  setDone(r: Reminder, done: boolean) {
    const ref = this.refById(r.id);
    return done
      ? updateDoc(ref, {
        doneAt: serverTimestamp(), pending: false,
        expireAt: Timestamp.fromMillis(Date.now() + REMINDER_KEEP_DAYS * DAY),
      })
      : updateDoc(ref, {
        doneAt: deleteField(), expireAt: deleteField(),
        pending: !r.firedAt && r.at.toMillis() > Date.now(),
      });
  }

  /** 外す（課題・サブタスク・自由入力のどれでも） */
  removeById(id: string) {
    return deleteDoc(this.refById(id));
  }
}