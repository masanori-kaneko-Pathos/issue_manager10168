import { Component, input, output } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/** 選んでいる間、画面の下に出る帯。件数と「選択を外す」は共通、操作のボタンは呼ぶ側が中に入れる */
@Component({
  selector: 'app-bulk-bar',
  imports: [TPipe],
  template: `
    <div class="bar" role="region" [attr.aria-label]="'bulk.selected' | t: { n: '' + count() }">
      <strong class="count">{{ 'bulk.selected' | t: { n: '' + count() } }}</strong>
      <div class="actions"><ng-content /></div>
      <button type="button" class="link" (click)="clear.emit()">{{ 'bulk.clear' | t }}</button>
    </div>
  `,
  styles: `
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px;
      border-radius: 10px; background: var(--text); color: var(--surface); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
    .count { font-size: 14px; white-space: nowrap; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
    .link { background: none; border: none; color: inherit; text-decoration: underline; min-height: 40px;
      font-size: 13px; cursor: pointer; }
  `,
})
export class BulkBar {
  count = input.required<number>();
  clear = output<void>();
}