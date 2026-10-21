import { ApplicationRef, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Selection } from '../../shared/selection';
import { BulkBar } from '../../shared/bulk-bar';
import { UndoService } from '../../core/undo/undo.service';
import { ActivatedRoute } from '@angular/router';
import { InboxMemo } from '../../core/models';
import { MemoRow } from '../../shared/memo-row';
import { I18nService, TPipe } from '../../i18n/i18n';
import { INBOX_TRASH_DAYS, InboxService, pinnedStable } from '../../core/inbox/inbox.service';
import { smoothly } from '../../core/smoothly';


/** 受信箱：未整理のメモの一覧。直す・課題にする・ゴミ箱へ。ゴミ箱は30日で自動で消える */
@Component({
  selector: 'app-inbox',
  imports: [TPipe, MemoRow, BulkBar],
  template: `
    <main>
      <div class="head">
        <h1>{{ 'inbox.title' | t }}</h1>
        <button type="button" class="primary" (click)="inbox.openPen()">{{ 'inbox.write' | t }}</button>
      </div>
      <p class="help">{{ 'inbox.onlyYou' | t }}</p>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (!inbox.loaded()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        @if (list().length) {
          <label class="pick-all">
            <input type="checkbox" [checked]="allPicked()" (change)="sel.toggleAll(visibleIds())" />
            {{ 'bulk.selectAll' | t }}
          </label>
        }
        <ul class="list">
          @for (m of list(); track m.id) {
            <!-- view-transition-name：並びが変わるとき、同じ行だとブラウザに教えて、すーっと動かす -->
            <li class="memo" [class.picked]="sel.has(m.id)" [style.view-transition-name]="'memo-' + m.id">
              <input type="checkbox" class="pick" [checked]="sel.has(m.id)" (change)="sel.toggle(m.id)"
                [attr.aria-label]="'inbox.select' | t: { title: m.title }" />
              <app-memo-row [memo]="m" touchUi="icons" [startEditing]="m.id === openId" (saved)="bump(m.id)" />
            </li>
          } @empty {
            <li class="empty">{{ 'inbox.empty' | t }}</li>
          }
        </ul>

        @if (sel.any()) {
          <div class="bulk-wrap">
            <app-bulk-bar [count]="sel.count()" (clear)="sel.clear()">
              <button type="button" class="bulk-btn" [disabled]="bulkBusy()" (click)="runBulk('pin')">{{ 'inbox.pin' | t }}</button>
              <button type="button" class="bulk-btn" [disabled]="bulkBusy()" (click)="runBulk('unpin')">{{ 'inbox.unpin' | t }}</button>
              <button type="button" class="bulk-btn danger" [disabled]="bulkBusy()" (click)="runBulk('discard')">
                {{ 'inbox.bulkDiscard' | t }}</button>
            </app-bulk-bar>
          </div>
        }
        <button type="button" class="link" [attr.aria-expanded]="showTrash()" (click)="showTrash.set(!showTrash())">
          {{ 'inbox.trash' | t: { n: '' + inbox.trash().length } }}</button>
        @if (showTrash()) {
          <p class="help">{{ 'inbox.trashHelp' | t: { n: '' + trashDays } }}</p>
          <ul class="list trash">
            @for (m of inbox.trash(); track m.id) {
              <li>
                <div class="main"><p class="memo-title">{{ m.title }}</p></div>
                <div class="actions">
                  <button type="button" class="link" [disabled]="busyId() === m.id" (click)="restore(m)">
                    {{ 'inbox.restore' | t }}</button>
                  <button type="button" class="link danger" [disabled]="busyId() === m.id" (click)="purge(m)">
                    {{ 'inbox.purge' | t }}</button>
                </div>
              </li>
            } @empty {
              <li class="empty">{{ 'inbox.trashEmpty' | t }}</li>
            }
          </ul>
        }
      }
    </main>
  `,
  styles: `
    main { max-width: 720px; margin: 0 auto; padding: 16px 16px 48px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 20px; margin: 0; }
    .help { font-size: 12px; color: var(--text-muted); margin: 8px 0; }
    .error { color: var(--danger-text); }
    .primary { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px; border-radius: 8px;
      border: none; background: var(--primary); color: var(--on-primary); text-decoration: none; font-size: 14px;
      cursor: pointer; }
    .list { list-style: none; padding: 0; margin: 8px 0 16px; }
    .list li { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 4px;
      border-bottom: 1px solid var(--border); }
    .memo-title { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-left: auto; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; cursor: pointer; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
    .trash .memo-title { color: var(--text-muted); }
    .empty { color: var(--text-muted); }
    .pick-all { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; min-height: 40px; cursor: pointer; }
    .pick, .pick-all input { width: 18px; height: 18px; cursor: pointer; }
    .list li.memo { flex-wrap: nowrap; }
    .list li.picked { background: var(--primary-bg); }
    .bulk-wrap { position: sticky; bottom: 12px; z-index: 15; margin: 12px 0; }
    .bulk-btn { min-height: 36px; padding: 0 12px; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 18px;
      background: none; color: inherit; font-size: 13px; cursor: pointer; }
    .bulk-btn:hover { background: rgba(255, 255, 255, 0.15); }
    .bulk-btn.danger { border-color: var(--danger); }
  `,
})
export class Inbox {
  protected inbox = inject(InboxService);
  private i18n = inject(I18nService);

  readonly trashDays = INBOX_TRASH_DAYS;
  /** 検索やホームから ?m= で来たとき、そのメモを直す状態で開く */
  readonly openId = inject(ActivatedRoute).snapshot.queryParamMap.get('m');
  showTrash = signal(false);
  busyId = signal<string | null>(null);
  error = signal('');
  /** 開いた時点の並び（直したメモが上へ跳ねないように。読み込み直すと、更新の新しい順に並び直る） */
  private order = signal<string[] | null>(null);
  /** ピン止めの群と、そうでない群。それぞれの中は、開いた時点の並びのまま（直したメモは、bump で上へ） */
  list = computed(() => pinnedStable(this.inbox.active(), this.order()));

  // ---- 選んで、まとめて操作（お知らせのページと同じ） ----
  readonly sel = new Selection();
  visibleIds = computed(() => this.list().map((m) => m.id));
  allPicked = computed(() => this.sel.allOf(this.visibleIds()));
  bulkBusy = signal(false);
  private undo = inject(UndoService);
  private appRef = inject(ApplicationRef);

  /** 選んだメモに、まとめて。ゴミ箱へは確認なし・元に戻すつき（1件のときと同じ） */
  async runBulk(op: 'pin' | 'unpin' | 'discard') {
    const ids = this.visibleIds().filter((id) => this.sel.has(id));
    if (!ids.length) return;
    this.bulkBusy.set(true);
    this.error.set('');
    try {
      if (op === 'discard') {
        await this.inbox.discardMany(ids);
        this.undo.offer('inbox.discardedN', { n: String(ids.length) }, () => this.inbox.restoreMany(ids));
      } else {
        await this.inbox.setPinnedMany(ids, op === 'pin');
      }
      this.sel.clear();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.bulkBusy.set(false);
    }
  }

  /** 直し終えたメモを、0.5秒待ってから、ピン止めしていない群の一番上へ、すーっと動かす */
  bump(id: string) {
    setTimeout(() => smoothly(this.appRef,
      () => this.order.update((o) => (o ? [id, ...o.filter((x) => x !== id)] : o))), 500);
  }

  constructor() {
    // ゴミ箱へ入れた・課題にしたメモは、選択から外す（見えないものを操作しないため）
    effect(() => this.sel.keepOnly(this.visibleIds()));
    // メモが届いたら、その時点の並びを1回だけ覚える
    effect(() => {
      if (this.inbox.loaded() && untracked(this.order) === null) {
        this.order.set(untracked(this.inbox.active).map((m) => m.id));
      }
    });
  }

  /** ゴミ箱から戻す（一覧に戻るだけ。前のようにメモのページへは移らない） */
  restore(m: InboxMemo) {
    return this.run(m, () => this.inbox.restore(m.id));
  }

  /** 完全に削除は元に戻せないので、確かめる */
  purge(m: InboxMemo) {
    if (!confirm(this.i18n.t('inbox.purgeConfirm'))) return;
    return this.run(m, () => this.inbox.purge(m.id));
  }

  /** 1件ずつの操作の共通部分（二度押しを防ぎ、失敗を知らせる） */
  private async run(m: InboxMemo, op: () => Promise<unknown>) {
    this.busyId.set(m.id);
    this.error.set('');
    try {
      await op();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busyId.set(null);
    }
  }
}