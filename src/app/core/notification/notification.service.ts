import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { NavigationExtras } from '@angular/router';
import {
  QueryDocumentSnapshot, Timestamp, collection, deleteDoc, deleteField, doc, limit, onSnapshot, orderBy, query,
  serverTimestamp, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { I18nService } from '../../i18n/i18n';
import { AppNotification, DailyGroup, NotificationType } from '../models';

const DAY = 24 * 60 * 60 * 1000;
/**
 * 朝のまとめの、形ごとの並べる順番。人数を添える区分は、人数の入っている数の名前も
 * ※ functions/src/index.ts の DAILY_KEYS・PEOPLE_OF と同じに保つこと
 */
const DAILY_KEYS: Record<DailyGroup, string[]> = {
  due: ['overdue', 'today', 'tomorrow', 'in3', 'effect', 'inboxOld'],
  priority: ['high', 'mid', 'low', 'effect', 'inboxOld'],
  assignee: ['active', 'overdueAll', 'effect', 'inboxOld'],
};
const PEOPLE_OF: Record<string, string> = { active: 'people', overdueAll: 'overduePeople' };
/** 通知が自動で消えるまでの日数（TTL） */
export const NOTIFY_KEEP_DAYS = 90;
/** 見張る件数（新しい順）。ピン止めは別に見張るので、この数に入らなくても落ちない */
export const NOTIFY_LIST_MAX = 50;

/** 1件・まとめての操作 */
export type NoticeOp = 'read' | 'unread' | 'pin' | 'unpin' | 'delete';

/** 通知に写しておく「どのプロジェクトの、どの課題の話か」 */
export interface NoticeAbout {
  pid: string;
  projectName: string;
  iid: string | null;
  issueNumber: number | null;
  issueTitle: string;
}

const newestFirst = (a: AppNotification, b: AppNotification) => b.at.toMillis() - a.at.toMillis();
const toNotice = (d: QueryDocumentSnapshot): AppNotification =>
  ({ ...(d.data({ serverTimestamps: 'estimate' }) as Omit<AppNotification, 'id'>), id: d.id });

/** 画面内の通知。作る・見張る・既読やピン止め・消す・文面と行き先を、ここにまとめる */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private recent = signal<AppNotification[]>([]);
  private pins = signal<AppNotification[]>([]);

  /** ピン止め（新しい順）→ それ以外（新しい順・最大 NOTIFY_LIST_MAX 件） */
  readonly list = computed(() => {
    const pins = [...this.pins()].sort(newestFirst);
    const pinned = new Set(pins.map((n) => n.id));
    return [...pins, ...this.recent().filter((n) => !pinned.has(n.id))];
  });
  /** 未読の件数（ベルの数字） */
  readonly unread = computed(() => this.list().filter((n) => !n.read).length);

  constructor() {
    // ログインしたら見張りを始め、ログアウトしたらやめる。新しい順の見張りと、ピン止めの見張りの2本
    effect((onCleanup) => {
      const uid = this.authService.user()?.uid;
      if (!uid) {
        this.recent.set([]);
        this.pins.set([]);
        return;
      }
      const col = collection(db, 'users', uid, 'notifications');
      const stopRecent = onSnapshot(query(col, orderBy('at', 'desc'), limit(NOTIFY_LIST_MAX)),
        (s) => this.recent.set(s.docs.map(toNotice)), (e) => console.error('通知の見張りに失敗', e));
      const stopPins = onSnapshot(query(col, where('pinned', '==', true)),
        (s) => this.pins.set(s.docs.map(toNotice)), (e) => console.error('ピン止めの見張りに失敗', e));
      onCleanup(() => {
        stopRecent();
        stopPins();
      });
    });
  }

  private ref(id: string) {
    return doc(db, 'users', auth.currentUser!.uid, 'notifications', id);
  }

  /** 操作ごとの書き換え（null は「消す」） */
  private change(op: NoticeOp): Record<string, unknown> | null {
    switch (op) {
      case 'read': return { read: true };
      case 'unread': return { read: false };
      // ピン止めは自動で消さない：期限の項目を消す。外したら、その時から90日後に消えるようにする
      case 'pin': return { pinned: true, expireAt: deleteField() };
      case 'unpin': return { pinned: false, expireAt: Timestamp.fromMillis(Date.now() + NOTIFY_KEEP_DAYS * DAY) };
      default: return null;
    }
  }

  markRead(id: string) {
    return updateDoc(this.ref(id), { read: true });
  }

  /** 1件の操作（ベルの小窓の ⋮ から） */
  apply(id: string, op: NoticeOp) {
    const c = this.change(op);
    return c ? updateDoc(this.ref(id), c) : deleteDoc(this.ref(id));
  }

  /** まとめての操作（お知らせのページから）。まとめ書きは500件までなので、400件ずつ */
  async applyMany(ids: string[], op: NoticeOp) {
    const c = this.change(op);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      for (const id of ids.slice(i, i + 400)) {
        if (c) batch.update(this.ref(id), c);
        else batch.delete(this.ref(id));
      }
      await batch.commit();
    }
  }

  /** 見えている未読を、まとめて既読にする */
  async markAllRead() {
    const ids = this.list().filter((n) => !n.read).map((n) => n.id);
    if (ids.length) await this.applyMany(ids, 'read');
  }

  /** 通知の文面（ベルの小窓とお知らせのページで共通） */
  text(n: AppNotification) {
    // 朝のまとめは、0件でない区分だけを「・」でつなぐ
    // 朝のまとめは、送ったときの形で、0件でない区分だけを「・」でつなぐ（形のない古いものは期限別）
    if (n.type === 'daily' && n.counts) {
      const c = n.counts;
      const parts = (DAILY_KEYS[n.group ?? 'due'] ?? DAILY_KEYS.due)
        .filter((k) => (c[k] ?? 0) > 0)
        .map((k) => this.i18n.t('notify.daily.' + k, { n: String(c[k]), p: String(c[PEOPLE_OF[k]] ?? '') }))
        .join(this.i18n.lang() === 'ja' ? '・' : ', ');
      return this.i18n.t('notify.types.daily', { parts });
    }
    return this.i18n.t('notify.types.' + n.type, {
      name: n.byName, n: String(n.issueNumber ?? ''), title: n.issueTitle, project: n.projectName,
      role: n.role ? this.i18n.t('roles.' + n.role) : '',
    });
  }

  /** 押したときの行き先（プッシュの pushUrl と同じ決まり） */
  target(n: AppNotification): { commands: unknown[]; extras: NavigationExtras } {
    if (n.type === 'daily') return { commands: ['/'], extras: { fragment: 'today' } };
    // 招待：まだメンバーではないので、ホームの「届いている招待」へ
    if (n.type === 'invited') return { commands: ['/'], extras: {} };
    // 自由入力のリマインド：課題がないので、今の画面のまま一覧の窓を開く（窓の側が ?reminders=1 を見て開き、印を消す）
    if (n.type === 'reminder' && !n.iid) {
      return { commands: [], extras: { queryParams: { reminders: '1' }, queryParamsHandling: 'merge' } };
    }
    if (n.iid) return { commands: ['/p', n.pid, 'i', n.iid], extras: {} };
    if (n.type === 'projectDeleted') return { commands: ['/'], extras: {} };
    if (n.type === 'recurringStopped') return { commands: ['/p', n.pid, 'recurring'], extras: {} };
    // 引き継いだ課題が見えるよう、自分の担当で絞ったリストへ
    if (n.type === 'handover') {
      return { commands: ['/p', n.pid, 'list'], extras: { queryParams: { assignee: auth.currentUser!.uid } } };
    }
    return { commands: ['/p', n.pid], extras: {} };
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