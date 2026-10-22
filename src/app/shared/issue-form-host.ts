import { Component, computed, forwardRef, inject } from '@angular/core';
import { NavigationStart, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { IssueNew } from '../pages/issue/issue-new';
import { ISSUE_NEW_EMBED, IssueFormService, IssueNewEmbed } from '../core/issue/issue-form.service';
import { TPipe } from '../i18n/i18n';

/**
 * 課題の登録の窓（アプリに1つ）。中には登録画面そのものを置くので、登録の決まりは1か所のまま。
 * 外・Esc・✕ は閉じる（書きかけは下書きに残る）。登録画面は、開くときに初めて読み込む（@defer）
 */
@Component({
  selector: 'app-issue-form-host',
  imports: [IssueNew, RouterLink, TPipe],
  providers: [{ provide: ISSUE_NEW_EMBED, useExisting: forwardRef(() => IssueFormHost) }],
  host: { '(document:keydown.escape)': 'onEsc()' },
  template: `
    @for (c of shown(); track c.key) {
      <div class="layer" animate.leave="im-out-dialog">
        <div class="backdrop" (click)="form.close()"></div>
        <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'issueNew.title' | t">
          <button type="button" class="x" [attr.aria-label]="'workflow.cancel' | t" [title]="'workflow.cancel' | t"
            (click)="form.close()">✕</button>
          @defer (on immediate) {
            <app-issue-new />
          } @loading {
            <p class="loading">{{ 'common.loading' | t }}</p>
          }
        </section>
      </div>
    }
    @if (form.created(); as c) {
      <div class="made" role="status" animate.leave="im-out">
        <span>{{ 'issueNew.created' | t: { n: '' + c.number } }}</span>
        <a [routerLink]="['/p', c.pid, 'i', c.iid]" (click)="form.created.set(null)">{{ 'issueNew.openCreated' | t }}</a>
      </div>
    }
  `,
  styles: `
    .layer { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { width: min(680px, calc(100% - 32px)); padding: 0; }
    app-issue-new { display: block; }
    .x { position: absolute; top: 8px; right: 8px; z-index: 1; width: 36px; height: 36px; border: none;
      border-radius: 50%; background: none; color: var(--text-muted); font-size: 18px; cursor: pointer; }
    .x:hover { background: var(--surface-alt); color: var(--text); }
    .loading { padding: 24px; }
    .made { position: fixed; left: 24px; bottom: 24px; z-index: 90; display: flex; align-items: center; gap: 12px;
      padding: 10px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25); }
    .made a { color: var(--primary-bg); font-weight: bold; }
  `,
})
export class IssueFormHost implements IssueNewEmbed {
  protected form = inject(IssueFormService);
  shown = computed(() => {
    const c = this.form.current();
    return c ? [c] : [];
  });

  constructor() {
    // 窓の中から別の画面へ移ったら（添付の失敗で詳細へ、など）、窓を閉じる
    inject(Router).events.pipe(filter((e) => e instanceof NavigationStart), takeUntilDestroyed())
      .subscribe(() => this.form.close());
  }

  get pid() {
    return this.form.current()?.pid ?? null;
  }
  get query() {
    return this.form.current()?.query ?? {};
  }
  done(r: { pid: string; iid: string; number: number }) {
    this.form.done(r);
  }
  close() {
    this.form.close();
  }
  onEsc() {
    if (this.form.current()) this.form.close();
  }
}