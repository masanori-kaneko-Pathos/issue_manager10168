import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Location } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { InboxService } from '../../core/inbox/inbox.service';
import { IS_TOUCH, enterKey } from '../../core/dom';
import { TPipe } from '../../i18n/i18n';

/** メモを書くページ。タイトルだけで、Enter で受信箱に入れ、元の画面に戻る */
@Component({
  selector: 'app-inbox-new',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
    <main>
      <div class="head">
        <h1>{{ 'inbox.write' | t }}</h1>
        <a routerLink="/inbox" class="link">{{ 'inbox.open' | t: { n: '' + inbox.count() } }}</a>
      </div>

      <input class="title" name="title" [(ngModel)]="title" maxlength="200" autofocus autocomplete="off"
        [placeholder]="'inbox.titlePlaceholder' | t" [attr.aria-label]="'issue.title' | t"
        (keydown)="onTitleKey($event)" />

      @if (showBody()) {
        <textarea name="body" [(ngModel)]="body" rows="5" maxlength="5000"
          [placeholder]="'inbox.bodyPlaceholder' | t" [attr.aria-label]="'issue.description' | t"
          (keydown)="onBodyKey($event)"></textarea>
      } @else {
        <button type="button" class="link" (click)="showBody.set(true)">{{ 'inbox.showBody' | t }}</button>
      }

      <p class="help">{{ (touch ? 'inbox.keysHelpTouch' : 'inbox.keysHelp') | t }}</p>
      <p class="help">{{ 'inbox.onlyYou' | t }}</p>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      <div class="row">
        <button type="button" class="link" (click)="back()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !title.trim()" (click)="save()">
          {{ 'inbox.save' | t }}</button>
      </div>
    </main>
  `,
  styles: `
    main { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 20px; margin: 0; }
    .title { min-height: 52px; font-size: 18px; padding: 0 12px; }
    textarea { font-size: 16px; padding: 8px 12px; }
    .help { margin: 0; font-size: 12px; color: var(--text-muted); }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; text-decoration: none;
      display: inline-flex; align-items: center; align-self: flex-start; font-size: 14px; cursor: pointer; }
    .primary { min-height: 48px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 15px; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
  `,
})
export class InboxNew {
  protected inbox = inject(InboxService);
  private location = inject(Location);
  private router = inject(Router);

  title = '';
  body = '';
  showBody = signal(false);
  busy = signal(false);
  error = signal('');
  readonly touch = IS_TOUCH;

  onTitleKey(e: KeyboardEvent) {
    enterKey(e, () => this.save());
  }

  onBodyKey(e: KeyboardEvent) {
    const next = enterKey(e, () => this.save(), true);
    if (next !== null) this.body = next;
  }

  async save() {
    const title = this.title.trim();
    if (!title || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.inbox.add(title, this.body.trim());
      this.inbox.showFlash('inbox.saved');
      this.back();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** アプリの中で前の画面があればそこへ。なければホームへ */
  back() {
    const navigationId = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    if (navigationId > 1) this.location.back();
    else this.router.navigate(['/']);
  }
}