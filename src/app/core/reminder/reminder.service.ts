import { Injectable } from '@angular/core';
import {
  FirestoreError, Timestamp, Unsubscribe, addDoc, collection, deleteDoc, deleteField, doc, onSnapshot,
  serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { REMINDER_KEEP_DAYS, Reminder } from '../models';

const DAY = 24 * 60 * 60 * 1000;

/** 課題・サブタスクのリマインドの「何についてか」（写しに使う値も一緒に） */
export interface ReminderTarget {
  pid: string;
  iid: string;
  number: number;
  title: string;        // 課題名
  projectName: string;
  sid?: string;         // サブタスクのときだけ
  subTitle?: string;    // サブタスク名
}

/** リマインドから、対象の課題を取り出す（自由入力なら null） */
export function targetOf(r: Reminder): ReminderTarget | null {
  if (!r.pid || !r.iid) return null;
  return {
    pid: r.pid, iid: r.iid, number: r.number ?? 0, title: r.title, projectName: r.projectName ?? '',
    ...(r.sid ? { sid: r.sid, subTitle: r.subTitle ?? '' } : {}),
  };
}

/**
 * リマインド（自分だけの、独立した機能）。作る・直す・完了・外す・見張る。
 * 課題は「何についてか」の対象の1つ。1つの課題にいくつでも置ける（名前はどれも自動）
 */
@Injectable({ providedIn: 'root' })
export class ReminderService {
  private col() {
    return collection(db, 'users', auth.currentUser!.uid, 'reminders');
  }

  private refById(id: string) {
    return doc(this.col(), id);
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

  /** 課題（とサブタスク）について作る */
  addIssue(t: ReminderTarget, note: string, at: Date) {
    return addDoc(this.col(), {
      pid: t.pid, iid: t.iid, number: t.number, title: t.title.slice(0, 200),
      projectName: t.projectName.slice(0, 100), note: note.slice(0, 1000),
      at: Timestamp.fromDate(at), createdAt: serverTimestamp(), pending: true,
      ...(t.sid ? { sid: t.sid, subTitle: (t.subTitle ?? '').slice(0, 200) } : {}),
    });
  }

  /** 自由入力で作る */
  addFree(title: string, note: string, at: Date) {
    return addDoc(this.col(), {
      title: title.slice(0, 200), note: note.slice(0, 1000),
      at: Timestamp.fromDate(at), createdAt: serverTimestamp(), pending: true,
    });
  }

  /**
   * 今あるリマインドを直す（課題でも自由入力でも）。text は、自由入力なら題名とメモ、課題ならメモだけ。
   * at を渡したとき（時刻を変えたとき）だけ予定に戻す（届いたもの・完了済みでも、もう一度届く）
   */
  update(id: string, text: { title?: string; note: string }, at: Date | null) {
    const t = {
      ...(text.title !== undefined ? { title: text.title.slice(0, 200) } : {}),
      note: text.note.slice(0, 1000),
    };
    return updateDoc(this.refById(id), at
      ? {
        ...t, at: Timestamp.fromDate(at), pending: true,
        firedAt: deleteField(), doneAt: deleteField(), expireAt: deleteField(),
      }
      : t);
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

  /** 外す */
  removeById(id: string) {
    return deleteDoc(this.refById(id));
  }
}