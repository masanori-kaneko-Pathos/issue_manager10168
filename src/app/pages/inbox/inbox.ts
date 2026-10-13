import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Clock } from '../../core/time/clock';
import { INBOX_TRASH_DAYS, InboxService } from '../../core/inbox/inbox.service';
import { InboxMemo } from '../../core/models';
import { relativeTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 受信箱：未整理のメモの一覧。直す・課題にする・ゴミ箱へ。ゴミ箱は30日で自動で消える */
@Component({
  selector: 'app-inbox',
  imports: [RouterLink, TPipe],
  template: `
    <main>
      <div class="head">
        <h1>{{ 'inbox.title' | t }}</h1>
        <a routerLink="/inbox/new" class="primary">{{ 'inbox.write' | t }}</a>
      </div>
      <p class="help">{{ 'inbox.onlyYou' | t }}</p>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (!inbox.loaded()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <ul class="list">
          @for (m of inbox.active(); track m.id) {
            <li>
              <a class="main" [routerLink]="['/inbox', m.id]">
                <p class="memo-title">{{ m.title }}
                  @if (inbox.isOld(m)) { <span class="old">{{ 'inbox.old' | t }}</span> }</p>
                @if (m.body) { <p class="body">{{ firstLine(m.body) }}</p> }
                <p class="meta">{{ when(m) }}</p>
              </a>
              <div class="actions">
                <a class="small primary-btn" [routerLink]="['/new']" [queryParams]="{ memo: m.id }">
                  {{ 'inbox.toIssue' | t }}</a>
              </div>
            </li>
          } @empty {
            <li class="empty">{{ 'inbox.empty' | t }}</li>
          }
        </ul>

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
      background: var(--primary); color: var(--on-primary); text-decoration: none; font-size: 14px; }
    .list { list-style: none; padding: 0; margin: 8px 0 16px; }
    .list li { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 4px;
      border-bottom: 1px solid var(--border); }
    .list li input, .list li textarea { flex-basis: 100%; font-size: 16px; padding: 8px 12px; }
    .list li input { min-height: 44px; }
    .main { flex: 1; min-width: 60%; display: block; color: inherit; text-decoration: none;
      border-radius: 6px; padding: 2px 4px; margin: -2px -4px; }
    .main:hover { background: var(--surface-alt); }
    .body { overflow: hidden; text-overflow: ellipsis; white-space: nowrap !important; }
    .memo-title { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .old { margin-left: 6px; font-size: 11px; padding: 1px 8px; border-radius: 10px;
      background: var(--warning-bg); color: var(--warning-text); }
    .body { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta { margin: 4px 0 0; font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-left: auto; }
    .small { min-height: 36px; padding: 0 12px; font-size: 13px; }
    .primary-btn { display: inline-flex; align-items: center; border: none; border-radius: 8px; text-decoration: none;
      background: var(--primary); color: var(--on-primary); cursor: pointer; }
    .primary-btn:disabled { background: var(--disabled); }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; cursor: pointer; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
    .trash .memo-title { color: var(--text-muted); }
    .empty { color: var(--text-muted); }
  `,
})
export class Inbox {
    protected inbox = inject(InboxService);
    private clock = inject(Clock);
    private i18n = inject(I18nService);
    private router = inject(Router);
  
    readonly trashDays = INBOX_TRASH_DAYS;
    showTrash = signal(false);
    busyId = signal<string | null>(null);
    error = signal('');

  when(m: InboxMemo) {
    return relativeTime(m.createdAt.toMillis(), this.i18n.lang(), this.clock.now());
  }

  /** 本文の1行目（一覧では1行だけ出す） */
  firstLine(body: string) {
    return body.split('\n')[0];
  }

  /** 戻したら、そのメモのページへ（戻した理由は、たいてい「もう一度見たい・直したい」だから） */
  async restore(m: InboxMemo) {
    await this.run(m, () => this.inbox.restore(m.id));
    if (!this.error()) this.router.navigate(['/inbox', m.id]);
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