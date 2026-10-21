import { Component, input } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/**
 * 定期課題から作られた課題の印（↻）。リスト・かんばん・カレンダー・ガント・ホーム・詳細で使い回す。
 * decorative＝となりに「定期課題から」の文字があるとき（読み上げで二重にならないように、絵だけにする）
 */
@Component({
  selector: 'app-recur-mark',
  imports: [TPipe],
  template: `
    <span class="mark" [attr.role]="decorative() ? null : 'img'"
      [attr.aria-label]="decorative() ? null : ('recurring.badge' | t)" [attr.aria-hidden]="decorative() ? true : null"
      [title]="'recurring.badge' | t">
      <svg viewBox="0 0 24 24" [attr.width]="size()" [attr.height]="size()" aria-hidden="true" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m17 2 4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" />
        <path d="m7 22-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></svg>
    </span>
  `,
  styles: `
    :host { display: inline-flex; vertical-align: -0.1em; color: var(--text-muted); }
    .mark { display: inline-flex; }
  `,
})
export class RecurMark {
  size = input(12);
  decorative = input(false);
}