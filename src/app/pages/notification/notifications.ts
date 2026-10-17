import { Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AppNotification } from '../../core/models';
import { NOTIFY_KEEP_DAYS, NoticeOp, NotificationService } from '../../core/notification/notification.service';
import { Clock } from '../../core/time/clock';
import { relativeTime } from '../../core/time/time';
import { Selection } from '../../shared/selection';
import { BulkBar } from '../../shared/bulk-bar';
import { I18nService, TPipe } from '../../i18n/i18n';

/** お知らせのページ。選んで、まとめて既読・未読・ピン止め・削除（ベルの小窓は1件ずつ） */
@Component({
  selector: 'app-notifications',
  imports: [TPipe, BulkBar],
  template: `
    <main>
      <div class="head">
        <h1>{{ 'notify.title' | t }}</h1>
        <div class="chips" role="group">
          <button type="button" [class.on]="!unreadOnly()" [attr.aria-pressed]="!unreadOnly()"
            (click)="unreadOnly.set(false)">{{ 'notify.filterAll' | t }}</button>
          <button type="button" [class.on]="unreadOnly()" [attr.aria-pressed]="unreadOnly()"
            (click)="unreadOnly.set(true)">{{ 'notify.filterUnread' | t }}</button>
        </div>
      </div>
      <p class="help">{{ 'notify.pageHelp' | t: { n: '' + keepDays } }}</p>

      @if (visible().length) {
        <label class="pick-all">
          <input type="checkbox" [checked]="allPicked()" (change)="sel.toggleAll(visibleIds())" />
          {{ 'bulk.selectAll' | t }}
        </label>
      }
      <ul class="list">
        @for (n of visible(); track n.id) {
          <li [class.picked]="sel.has(n.id)">
            <input type="checkbox" class="pick" [checked]="sel.has(n.id)" (change)="sel.toggle(n.id)"
              [attr.aria-label]="'notify.select' | t" />
            <button type="button" class="item" [class.unread]="!n.read" (click)="open(n)">
              <span class="text">
                @if (!n.read) { <span class="dot" role="img" [attr.aria-label]="'notify.unread' | t"></span> }
                @if (n.pinned) { <span role="img" [attr.aria-label]="'notify.pinned' | t">📌</span> }
                {{ notify.text(n) }}</span>
              @if (n.detail) { <span class="detail">{{ n.detail }}</span> }
              <span class="meta">{{ n.projectName ? n.projectName + ' · ' : '' }}{{ when(n) }}</span>
            </button>
          </li>
        } @empty {
          <li class="empty">{{ (unreadOnly() ? 'notify.emptyUnread' : 'notify.empty') | t }}</li>
        }
      </ul>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (sel.any()) {
        <div class="bulk-wrap">
          <app-bulk-bar [count]="sel.count()" (clear)="sel.clear()">
            <button type="button" class="bulk-btn" [disabled]="busy()" (click)="run('read')">{{ 'notify.markRead' | t }}</button>
            <button type="button" class="bulk-btn" [disabled]="busy()" (click)="run('unread')">{{ 'notify.markUnread' | t }}</button>
            <button type="button" class="bulk-btn" [disabled]="busy()" (click)="run('pin')">{{ 'notify.pin' | t }}</button>
            <button type="button" class="bulk-btn" [disabled]="busy()" (click)="run('unpin')">{{ 'notify.unpin' | t }}</button>
            <button type="button" class="bulk-btn danger" [disabled]="busy()" (click)="run('delete')">{{ 'notify.delete' | t }}</button>
          </app-bulk-bar>
        </div>
      }
    </main>
  `,
  styles: `
    main { max-width: 720px; margin: 0 auto; padding: 16px 16px 48px; }
    .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 20px; margin: 0; }
    .chips { display: flex; gap: 6px; }
    .chips button { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 18px; font-size: 13px; cursor: pointer; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .help { font-size: 12px; color: var(--text-muted); margin: 8px 0; }
    .pick-all { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; min-height: 40px; cursor: pointer; }
    .pick, .pick-all input { width: 18px; height: 18px; cursor: pointer; }
    .list { list-style: none; margin: 0; padding: 0; }
    .list li { display: flex; align-items: flex-start; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--border); }
    .list li.picked { background: var(--primary-bg); }
    .pick { margin-top: 4px; }
    .item { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 2px 4px; border: none;
      background: none; text-align: left; color: var(--text); font-size: 14px; line-height: 1.5; cursor: pointer; }
    .item:hover { background: var(--surface-alt); }
    .item.unread .text { font-weight: bold; }
    .dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; background: var(--primary); }
    .detail { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 11px; color: var(--text-muted); }
    .empty { color: var(--text-muted); padding: 12px 4px; }
    .error { color: var(--danger-text); }
    .bulk-wrap { position: sticky; bottom: 12px; z-index: 15; margin-top: 12px; }
    .bulk-btn { min-height: 36px; padding: 0 12px; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 18px;
      background: none; color: inherit; font-size: 13px; cursor: pointer; }
    .bulk-btn:hover { background: rgba(255, 255, 255, 0.15); }
    .bulk-btn.danger { border-color: var(--danger); }
  `,
})
export class Notifications {
  protected notify = inject(NotificationService);
  private router = inject(Router);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  readonly keepDays = NOTIFY_KEEP_DAYS;
  readonly sel = new Selection();
  unreadOnly = signal(false);
  busy = signal(false);
  error = signal('');

  visible = computed(() => this.notify.list().filter((n) => !this.unreadOnly() || !n.read));
  visibleIds = computed(() => this.visible().map((n) => n.id));
  allPicked = computed(() => this.sel.allOf(this.visibleIds()));

  constructor() {
    // 絞り込みで見えなくなった・消えたお知らせは、選択から外す（見えないものを操作しないため）
    effect(() => this.sel.keepOnly(this.visibleIds()));
  }

  when(n: AppNotification) {
    return relativeTime(n.at.toMillis(), this.i18n.lang(), this.clock.now());
  }

  /** 既読にして、その行き先へ */
  open(n: AppNotification) {
    if (!n.read) this.notify.markRead(n.id).catch((e) => console.error(e));
    const t = this.notify.target(n);
    this.router.navigate(t.commands, t.extras);
  }

  /** 選んだお知らせに、まとめて同じ操作をする（削除も確認なし・赤K：中身は課題の経緯に残っているため） */
  async run(op: NoticeOp) {
    const ids = this.visibleIds().filter((id) => this.sel.has(id));
    if (!ids.length) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.notify.applyMany(ids, op);
      this.sel.clear();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}