import { Injectable, signal } from '@angular/core';
import {
  FirestoreError, Timestamp, Unsubscribe, collection, deleteDoc, deleteField, doc, onSnapshot, serverTimestamp,
  setDoc, updateDoc,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { RecurringTemplate } from '../models';
import { nextOccurrence } from './schedule';

/** 窓で入れる中身（いつ・何を作るか） */
export type RecurringInput = Pick<RecurringTemplate,
  'title' | 'type' | 'importance' | 'assigneeId' | 'doneCriteria' | 'description' | 'labelIds'
  | 'freq' | 'weekdays' | 'monthDay' | 'time' | 'tz' | 'dueDays'>;

/** 定期課題の雛形の読み書き（書けるのは管理者だけ。ルールで確認）。課題を作るのは関数 */
@Injectable({ providedIn: 'root' })
export class RecurringService {
  /** カレンダーに先の回を出すか（この端末に覚える。最初は出す。プロジェクトとホームのカレンダーで同じ） */
  showUpcoming = signal(this.readShow());

  private showKey() {
    return `issuemanager.recurCal.${auth.currentUser?.uid ?? ''}`;
  }

  private readShow() {
    try {
      return localStorage.getItem(this.showKey()) !== '0';
    } catch {
      return true;
    }
  }

  setShowUpcoming(on: boolean) {
    this.showUpcoming.set(on);
    try {
      localStorage.setItem(this.showKey(), on ? '1' : '0');
    } catch {
      // 覚えておけなくても、今は切り替えられる
    }
  }

  private col(pid: string) {
    return collection(db, 'projects', pid, 'recurring');
  }

  watch(pid: string, onData: (list: RecurringTemplate[]) => void, onError: (e: FirestoreError) => void): Unsubscribe {
    return onSnapshot(this.col(pid), (s) => onData(s.docs
      .map((d) => ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<RecurringTemplate, 'id'>), id: d.id }))
      .sort((a, b) => a.title.localeCompare(b.title))), onError);
  }

  /**
   * 作る・直す。次に作る時刻は、今から数え直す（決まりを変えたら、次の回も変わるため）。
   * 止まっていた雛形を直したら、動かし直す（担当者を選び直したはずなので。違えばルールが断る）
   */
  save(pid: string, current: RecurringTemplate | null, v: RecurringInput, uid: string) {
    const nextAt = Timestamp.fromMillis(nextOccurrence(v, Date.now()));
    if (!current) {
      return setDoc(doc(this.col(pid)), {
        ...v, active: true, nextAt, createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    return updateDoc(doc(this.col(pid), current.id), {
      ...v, nextAt, updatedAt: serverTimestamp(),
      // 止まっていた雛形を直したら、動かし直し、直した管理者が「作った人」を引き取る
      ...(current.stopped ? { active: true, stopped: deleteField(), createdBy: uid } : {}),
    });
  }

  /**
   * 止める・動かす。動かすときは、次の回を今から数え直す（止めていた間の回は作らない）。
   * 関数が止めた雛形を動かすときは、動かした管理者が「作った人」を引き取る
   */
  setActive(pid: string, r: RecurringTemplate, on: boolean, uid: string) {
    return updateDoc(doc(this.col(pid), r.id), {
      active: on, updatedAt: serverTimestamp(),
      ...(on ? { nextAt: Timestamp.fromMillis(nextOccurrence(r, Date.now())), stopped: deleteField() } : {}),
      ...(on && r.stopped ? { createdBy: uid } : {}),
    });
  }

  /** 次の回を飛ばす：次に作る時刻を、その次の回へ進めるだけ（年末年始などに） */
  skipNext(pid: string, r: RecurringTemplate) {
    return updateDoc(doc(this.col(pid), r.id), {
      nextAt: Timestamp.fromMillis(nextOccurrence(r, r.nextAt.toMillis())), updatedAt: serverTimestamp(),
    });
  }

  remove(pid: string, id: string) {
    return deleteDoc(doc(this.col(pid), id));
  }
}