import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { INBOX_TRASH_DAYS, InboxService, stableOrder } from '../../core/inbox/inbox.service';
import { InboxMemo } from '../../core/models';
import { MemoRow } from '../../shared/memo-row';
import { I18nService, TPipe } from '../../i18n/i18n';


/** 受信箱：未整理のメモの一覧。直す・課題にする・ゴミ箱へ。ゴミ箱は30日で自動で消える */
@Component({
  selector: 'app-inbox',
  imports: [RouterLink, TPipe, MemoRow],
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
          @for (m of list(); track m.id) {
            <li><app-memo-row [memo]="m" touchUi="icons" [startEditing]="m.id === openId" /></li>
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
    .memo-title { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-left: auto; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; cursor: pointer; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
    .trash .memo-title { color: var(--text-muted); }
    .empty { color: var(--text-muted); }
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
  list = computed(() => stableOrder(this.inbox.active(), this.order()));

  constructor() {
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