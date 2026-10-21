import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TPipe } from '../i18n/i18n';

/** 道しるべの1段。key（翻訳キー）か label（そのままの文字）のどちらかを入れる */
export interface Crumb { key?: string; label?: string; link: string | any[]; }

/** どのページでも先頭に来る「ホーム」 */
export const HOME: Crumb = { key: 'crumbs.home', link: '/' };

/**
 * 道しるべ：「ホーム › プロジェクト名 › （今いるページ）」。
 * 並べるのは上の階のリンクだけ。今いるページの名前は、使う側が中に差し込む（h1 などを、そのページの見た目のまま置ける）。
 * スマホでは、ひとつ上だけを「‹ 親の名前」で出す（幅が足りないため。他社のスマホ版と同じ形）
 */
@Component({
  selector: 'app-crumbs',
  imports: [RouterLink, TPipe],
  template: `
    <nav class="crumbs" [attr.aria-label]="'crumbs.nav' | t">
      @for (c of items(); track $index; let last = $last) {
        <span class="crumb" [class.parent]="last">
          @let text = c.key ? (c.key | t) : (c.label ?? '');
          <a [routerLink]="c.link" [title]="text">{{ text }}</a>
          <span class="sep" aria-hidden="true">›</span>
        </span>
      }
      <span class="here"><ng-content /></span>
    </nav>
  `,
  styles: `
    /* 並んだ帯の中で、残りの幅を全部使う（右の ⋮ を右端に押し出す） */
    :host { display: block; flex: 1; min-width: 0; }
    .crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 40px; }
    .crumb { display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
    /* 長いプロジェクト名は「…」。全文は title で見られる */
    .crumb a { display: inline-block; max-width: 240px; padding: 4px 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--primary); text-decoration: none; font-size: 14px; }
    .crumb a:hover { text-decoration: underline; }
    .sep { flex: none; color: var(--text-subtle); }
    .here { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
    @media (max-width: 600px) {
      .crumb:not(.parent) { display: none; }
      .parent .sep { display: none; }
      .parent a { max-width: 40vw; }
      .parent a::before { content: '‹ '; }
    }
  `,
})
export class Crumbs {
  items = input.required<Crumb[]>();
}