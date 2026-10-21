import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TPipe } from '../i18n/i18n';

/** 索引の1項目（path は道の最後の部分、icon は線の絵の path） */
export interface IndexItem { path: string; key: string; icon: string; }

/**
 * 設定の左の索引（GitHub の設定と同じ形）。今いるページは、左の青い線と太字。スマホは上に横並び。
 * 個人の設定とプロジェクトの設定で使い回す
 */
@Component({
  selector: 'app-side-index',
  imports: [RouterLink, RouterLinkActive, TPipe],
  template: `
    <nav class="index" [attr.aria-label]="label() | t">
      @for (s of items(); track s.path) {
        <a [routerLink]="link(s)" routerLinkActive="on">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="s.icon" /></svg>
          {{ s.key | t }}</a>
      }
    </nav>
  `,
  styles: `
    /* ページを下へ読み進めても見えたまま（アプリのヘッダーの下に止まる） */
    :host { display: block; position: sticky; top: 68px; }
    .index { display: flex; flex-direction: column; gap: 2px; }
    .index a { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; border-radius: 6px;
      color: var(--text); text-decoration: none; font-size: 14px; }
    .index a:hover { background: var(--surface-alt); }
    .index a.on { background: var(--surface-alt); font-weight: bold; box-shadow: inset 3px 0 0 var(--primary); }
    @media (max-width: 720px) {
      :host { position: static; }
      .index { flex-direction: row; overflow-x: auto; scrollbar-width: none; }
      .index::-webkit-scrollbar { display: none; }
      .index a { flex: none; white-space: nowrap; }
      .index a.on { box-shadow: inset 0 -2px 0 var(--primary); }
    }
  `,
})
export class SideIndex {
  items = input.required<IndexItem[]>();
  /** 索引のまとまりの名前（読み上げ用。翻訳キー） */
  label = input.required<string>();
  /** 道の頭に付けるもの（今いるページから見た相対の道。兄弟のページへなら ['..']） */
  prefix = input<string[]>([]);

  link(s: IndexItem) {
    return [...this.prefix(), s.path];
  }
}