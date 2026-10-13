import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  Timestamp, addDoc, collection, deleteDoc, deleteField, doc, getDoc, onSnapshot, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { Clock } from '../time/clock';
import { InboxMemo } from '../models';

const DAY = 24 * 60 * 60 * 1000;
/** ゴミ箱のメモが自動で消えるまでの日数 */
export const INBOX_TRASH_DAYS = 30;
/** この日数を過ぎたメモに「7日以上前」の印を付ける */
export const INBOX_OLD_DAYS = 7;

/**
 * 受信箱。ログインしている間、アプリ全体で見張りを1本だけ張る。
 * ヘッダーの件数・ホームの欄・受信箱のページは、すべてここを読む
 */
@Injectable({ providedIn: 'root' })
export class InboxService {
  private authService = inject(AuthService);
  private clock = inject(Clock);

  private items = signal<InboxMemo[]>([]);
  loaded = signal(false);
  /** 画面の上に数秒出す知らせ（翻訳キー） */
  flash = signal<string | null>(null);
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  /** 未整理のメモ（新しい順） */
  active = computed(() => this.items()
    .filter((m) => !m.discardedAt)
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()));
  /** ゴミ箱のメモ（捨てた順。自動で消える日時を過ぎたものは、実際に消えるまでの間も出さない） */
  trash = computed(() => {
    const now = this.clock.now();
    return this.items()
      .filter((m) => m.discardedAt && (m.expireAt?.toMillis() ?? Infinity) > now)
      .sort((a, b) => b.discardedAt!.toMillis() - a.discardedAt!.toMillis());
  });
  count = computed(() => this.active().length);
  /** id でメモを引く（ゴミ箱の中も含む。なければ null） */
  find(id: string) {
    return this.items().find((m) => m.id === id) ?? null;
  }

  constructor() {
    // ログインしたら見張りを始め、ログアウトしたらやめる
    effect((onCleanup) => {
      const uid = this.authService.user()?.uid;
      if (!uid) {
        this.items.set([]);
        this.loaded.set(false);
        return;
      }
      const stop = onSnapshot(
        collection(db, 'users', uid, 'inbox'),
        (s) => {
          this.items.set(s.docs.map((d) => ({
            ...(d.data({ serverTimestamps: 'estimate' }) as Omit<InboxMemo, 'id'>), id: d.id,
          })));
          this.loaded.set(true);
        },
        (e) => console.error('受信箱の見張りに失敗', e),
      );
      onCleanup(stop);
    });
  }

  private col() {
    return collection(db, 'users', this.authService.user()!.uid, 'inbox');
  }

  add(title: string, body: string) {
    return addDoc(this.col(), { title, body, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }

  async get(id: string): Promise<InboxMemo | null> {
    const s = await getDoc(doc(this.col(), id));
    return s.exists() ? { ...(s.data() as Omit<InboxMemo, 'id'>), id: s.id } : null;
  }

  update(id: string, title: string, body: string) {
    return updateDoc(doc(this.col(), id), { title, body, updatedAt: serverTimestamp() });
  }

  /** ゴミ箱に入れる。30日後の日時を expireAt に入れておくと、Firestore（TTL）が自動で消す */
  discard(id: string) {
    return updateDoc(doc(this.col(), id), {
      discardedAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + INBOX_TRASH_DAYS * DAY),
    });
  }

  /** ゴミ箱から戻す。expireAt を消すので、自動削除の対象から外れる */
  restore(id: string) {
    return updateDoc(doc(this.col(), id), { discardedAt: deleteField(), expireAt: deleteField() });
  }

  /** ゴミ箱から完全に削除する */
  purge(id: string) {
    return deleteDoc(doc(this.col(), id));
  }

  /** 7日以上たったメモか（時計で判定するので、開いたままでも日付が変われば付く） */
  isOld(m: InboxMemo) {
    return this.clock.now() - m.createdAt.toMillis() >= INBOX_OLD_DAYS * DAY;
  }

  showFlash(key: string) {
    this.flash.set(key);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flash.set(null), 4000);
  }
}