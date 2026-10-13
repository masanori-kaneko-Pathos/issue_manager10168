import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Clock } from '../../core/time/clock';
import { IS_TOUCH, enterKey } from '../../core/dom';
import { InboxService } from '../../core/inbox/inbox.service';
import { relativeTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';

/** メモ1件のページ。直す・課題として登録・破棄をここでまとめて行う */
@Component({
  selector: 'app-inbox-memo',
  imports: [FormsModule, RouterLink, TPipe],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    <main>
      <a routerLink="/inbox" class="link back">{{ 'inbox.back' | t }}</a>

      @if (!inbox.loaded()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!memo()) {
        <p>{{ 'inbox.notFound' | t }}</p>
      } @else {
        @let m = memo()!;
        @if (m.discardedAt) {
          <div class="trash" role="status">
            <p>{{ 'inbox.inTrash' | t }}</p>
            <button type="button" class="primary" [disabled]="busy()" (click)="restore()">{{ 'inbox.restore' | t }}</button>
          </div>
        }
        <p class="meta">{{ when() }}
          @if (old()) { <span class="old">{{ 'inbox.old' | t }}</span> }</p>

        <input class="title" name="title" [ngModel]="title()" (ngModelChange)="title.set($event)" maxlength="200"
          autocomplete="off" [attr.aria-label]="'issue.title' | t" (keydown)="onTitleKey($event)" />
        <textarea name="body" [ngModel]="body()" (ngModelChange)="body.set($event)" rows="8" maxlength="5000"
          [placeholder]="'inbox.bodyPlaceholder' | t" [attr.aria-label]="'issue.description' | t"
          (keydown)="onBodyKey($event)"></textarea>
        <p class="help">{{ (touch ? 'inbox.keysHelpTouch' : 'inbox.keysHelp') | t }}</p>

        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        @if (dirty()) {
          <div class="row">
            <button type="button" class="link" [disabled]="busy()" (click)="reset()">{{ 'settings.discard' | t }}</button>
            <button type="button" class="primary" [disabled]="busy() || !title().trim()" (click)="save()">
              {{ 'settings.saveChanges' | t }}</button>
          </div>
        }

        @if (!m.discardedAt) {
          <div class="actions">
            <button type="button" class="primary" [disabled]="busy() || !title().trim()" (click)="toIssue()">
              {{ 'inbox.toIssue' | t }}</button>
            <button type="button" class="link danger" [disabled]="busy()" (click)="discard()">
              {{ 'inbox.discard' | t }}</button>
          </div>
        }
      }
    </main>
  `,
  styles: `
    main { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; display: flex; flex-direction: column; gap: 12px; }
    .back { align-self: flex-start; }
    .meta { margin: 0; font-size: 12px; color: var(--text-muted); }
    .old { margin-left: 6px; font-size: 11px; padding: 1px 8px; border-radius: 10px;
      background: var(--warning-bg); color: var(--warning-text); }
    .title { min-height: 52px; font-size: 18px; padding: 0 12px; }
    textarea { font-size: 16px; padding: 8px 12px; }
    .help { margin: 0; font-size: 12px; color: var(--text-muted); }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .actions { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .trash { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
      padding: 10px 12px; border-radius: 8px; background: var(--surface-alt); }
    .trash p { margin: 0; font-size: 14px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; font-size: 14px;
      text-decoration: none; display: inline-flex; align-items: center; cursor: pointer; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); }
  `,
})
export class InboxMemo {
  protected inbox = inject(InboxService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  private readonly id = this.route.snapshot.paramMap.get('id')!;
  readonly touch = IS_TOUCH;

  /** 見張りから引いたメモ（課題にした・完全に削除したなら null） */
  memo = computed(() => this.inbox.find(this.id));
  title = signal('');
  body = signal('');
  busy = signal(false);
  error = signal('');
  /** 保存していない変更があるか */
  dirty = computed(() => {
    const m = this.memo();
    return !!m && (this.title().trim() !== m.title || this.body().trim() !== m.body);
  });
  old = computed(() => {
    const m = this.memo();
    return !!m && this.inbox.isOld(m);
  });
  when = computed(() => {
    const m = this.memo();
    return m ? relativeTime(m.createdAt.toMillis(), this.i18n.lang(), this.clock.now()) : '';
  });

  private filled = false;

  constructor() {
    // メモが届いたら、入力欄に1回だけ入れる（以後は、自分の入力を上書きしない）
    effect(() => {
      const m = this.memo();
      if (m && !this.filled) {
        this.title.set(m.title);
        this.body.set(m.body);
        this.filled = true;
      }
    });
  }

  onTitleKey(e: KeyboardEvent) {
    enterKey(e, () => this.save());
  }

  onBodyKey(e: KeyboardEvent) {
    const next = enterKey(e, () => this.save(), true);
    if (next !== null) this.body.set(next);
  }

  /** 入力を、保存されている内容に戻す */
  reset() {
    const m = this.memo();
    if (!m) return;
    this.title.set(m.title);
    this.body.set(m.body);
  }

  async save() {
    if (!this.dirty() || !this.title().trim()) return;
    await this.run(async () => {
      await this.inbox.update(this.id, this.title().trim(), this.body().trim());
      this.inbox.showFlash('settings.saved');
    });
  }

  /** 書きかけがあれば保存してから、登録画面へ（登録画面は保存済みのメモを読むため） */
  async toIssue() {
    if (this.dirty()) await this.save();
    if (this.dirty()) return; // 保存に失敗したら移らない
    this.router.navigate(['/new'], { queryParams: { memo: this.id } });
  }

  async discard() {
    await this.run(async () => {
      await this.inbox.discard(this.id);
      this.reset(); // 書きかけは捨てる（「保存していない変更」の確認を出さずに移るため）
      this.inbox.showFlash('inbox.discarded');
      this.router.navigate(['/inbox']);
    });
  }

  restore() {
    return this.run(() => this.inbox.restore(this.id));
  }

  onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.dirty()) e.preventDefault();
  }

  private async run(op: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await op();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}