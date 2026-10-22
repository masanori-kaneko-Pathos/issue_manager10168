import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { MAX_FREE_REMINDERS, Reminder } from '../models';
import { ReminderService, ReminderTarget, targetOf, targetRid } from './reminder.service';

/**
 * 窓に出している画面（null＝閉じている）。
 * edit：rid が null なら自由入力を新しく作る。target が null なら自由入力。fromList＝一覧から開いた（終わったら一覧へ戻る）
 */
export type HubView =
  | { kind: 'list' }
  | { kind: 'edit'; rid: string | null; target: ReminderTarget | null; fromList: boolean }
  | { kind: 'new' };

const byAt = (a: Reminder, b: Reminder) => a.at.toMillis() - b.at.toMillis();
/** 1行目に出す名前：自由入力は本文、課題は「#12 題名」、サブタスクはサブタスク名（窓と引き出しで同じ） */
export function reminderTitle(r: Reminder) {
    if (r.sid) return r.subTitle ?? '';
    if (r.pid) return `#${r.number} ${r.title}`;
    return r.title;
  }

/**
 * リマインドの窓（アプリに1つ）。どの画面からでも開ける。
 * 自分のリマインドの見張りもここに1本だけ置き、窓・引き出し・課題の詳細が同じ一覧を読む
 */
@Injectable({ providedIn: 'root' })
export class ReminderHub {
  private authService = inject(AuthService);
  private reminders = inject(ReminderService);

  readonly view = signal<HubView | null>(null);
  private all = signal<Reminder[]>([]);

  /** 届いたもの：完了を押すまで一番上に（古い順） */
  readonly fired = computed(() => this.all().filter((r) => !r.doneAt && !r.pending).sort(byAt));
  /** 予定（近い順） */
  readonly scheduled = computed(() => this.all().filter((r) => !r.doneAt && r.pending).sort(byAt));
  /** 完了済み（完了にしたのが新しい順） */
  readonly done = computed(() => this.all().filter((r) => !!r.doneAt)
    .sort((a, b) => b.doneAt!.toMillis() - a.doneAt!.toMillis()));
  /** 完了していない数（引き出しの件数。届いたものも数える） */
  readonly count = computed(() => this.fired().length + this.scheduled().length);
  /** 自由入力の数（完了済みも、消えるまでは数える） */
  readonly freeCount = computed(() => this.all().filter((r) => !r.pid).length);
  /** 自由入力がいっぱいか（ルールでは数えられないので、画面で止める） */
  readonly freeFull = computed(() => this.freeCount() >= MAX_FREE_REMINDERS);

  constructor() {
    // ログインしたら見張りを始め、ログアウトしたらやめて窓も閉じる
    effect((onCleanup) => {
      const uid = this.authService.user()?.uid;
      if (!uid) {
        this.all.set([]);
        this.view.set(null);
        return;
      }
      const stop = this.reminders.watchAll(uid, (list) => this.all.set(list),
        (e) => console.error('リマインドの見張りに失敗', e));
      onCleanup(stop);
    });
  }

  byId(id: string) {
    return this.all().find((r) => r.id === id) ?? null;
  }

  openList() {
    this.view.set({ kind: 'list' });
  }
  /** 一覧の行から：そのリマインドの変更の画面 */
  openEdit(rid: string) {
    const r = this.byId(rid);
    this.view.set({ kind: 'edit', rid, target: r ? targetOf(r) : null, fromList: true });
  }

  /**
   * その課題・サブタスクのリマインドの変更の画面（まだ無ければ、置く画面）。
   * 課題の ⋮ や札からは fromList＝false（終わったら閉じる）、「課題から選ぶ」からは true（終わったら一覧へ）
   */
  openFor(target: ReminderTarget, fromList = false) {
    this.view.set({ kind: 'edit', rid: targetRid(target), target, fromList });
  }
  openNew() {
    this.view.set({ kind: 'new' });
  }
  close() {
    this.view.set(null);
  }
}