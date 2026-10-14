import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  Timestamp, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { AppNotification, NotificationType } from '../models';

const DAY = 24 * 60 * 60 * 1000;
/** 通知が自動で消えるまでの日数（TTL） */
export const NOTIFY_KEEP_DAYS = 90;
/** パネルに出す件数（新しい順） */
export const NOTIFY_LIST_MAX = 50;

/** 通知に写しておく「どのプロジェクトの、どの課題の話か」 */
export interface NoticeAbout {
  pid: string;
  projectName: string;
  iid: string | null;
  issueNumber: number | null;
  issueTitle: string;
}

/** 画面内の通知。作る・見張る・既読にするを、ここにまとめる */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private authService = inject(AuthService);
  private items = signal<AppNotification[]>([]);
  /** 新しい順の通知（最大 NOTIFY_LIST_MAX 件） */
  readonly list = this.items.asReadonly();
  /** 未読の件数（ベルの数字） */
  readonly unread = computed(() => this.items().filter((n) => !n.read).length);

  constructor() {
    // ログインしたら見張りを始め、ログアウトしたらやめる（受信箱と同じ形）
    effect((onCleanup) => {
      const uid = this.authService.user()?.uid;
      if (!uid) {
        this.items.set([]);
        return;
      }
      const stop = onSnapshot(
        query(collection(db, 'users', uid, 'notifications'), orderBy('at', 'desc'), limit(NOTIFY_LIST_MAX)),
        (s) => this.items.set(s.docs.map((d) => ({
          ...(d.data({ serverTimestamps: 'estimate' }) as Omit<AppNotification, 'id'>), id: d.id,
        }))),
        (e) => console.error('通知の見張りに失敗', e),
      );
      onCleanup(stop);
    });
  }

  /** 1件を既読にする */
  markRead(id: string) {
    return updateDoc(doc(db, 'users', auth.currentUser!.uid, 'notifications', id), { read: true });
  }

  /** 見えている未読を、まとめて既読にする */
  async markAllRead() {
    const uid = auth.currentUser!.uid;
    const unread = this.items().filter((n) => !n.read);
    if (!unread.length) return;
    const batch = writeBatch(db);
    unread.forEach((n) => batch.update(doc(db, 'users', uid, 'notifications', n.id), { read: true }));
    await batch.commit();
  }

  /**
   * 通知の文書を1件ぶん用意する。書き込むのは呼ぶ側（保存と同じトランザクション・バッチで書くため）。
   * 宛先がいないか、自分なら null（自分宛ては作らない）
   */
  notice(to: string | null | undefined, type: NotificationType, about: NoticeAbout, detail = '') {
    const me = auth.currentUser!.uid;
    if (!to || to === me) return null;
    return {
      ref: doc(collection(db, 'users', to, 'notifications')),
      data: {
        type,
        ...about,
        by: me,
        byName: this.authService.myName().slice(0, 100),
        detail: detail.slice(0, 200),
        at: serverTimestamp(),
        read: false,
        expireAt: Timestamp.fromMillis(Date.now() + NOTIFY_KEEP_DAYS * DAY),
      },
    };
  }
}