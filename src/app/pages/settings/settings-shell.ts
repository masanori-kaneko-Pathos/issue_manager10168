import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TPipe } from '../../i18n/i18n';
import { SETTINGS_NAV } from '../../shared/settings-nav';
import { Crumbs, HOME } from '../../shared/crumbs';

/** 設定の入れ物：上に「‹ 設定」の帯、左に索引、右に各ページ（GitHub の設定と同じ形）。スマホは索引を上に横並び */
@Component({
  selector: 'app-settings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe, Crumbs],
  template: `
    <div class="head">
      <div class="head-in">
        <app-crumbs [items]="crumbs"><h1>{{ 'settings.title' | t }}</h1></app-crumbs>
      </div>
    </div>
    <div class="layout">
      <nav class="index" [attr.aria-label]="'settings.title' | t">
        @for (s of items; track s.path) {
          <a [routerLink]="s.path" routerLinkActive="on">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="s.icon" /></svg>
            {{ s.key | t }}</a>
        }
      </nav>
      <div class="page"><router-outlet /></div>
    </div>
  `,
  styles: `
    .head { background: var(--surface); border-bottom: 1px solid var(--border); }
    .head-in, .layout { max-width: 1040px; margin: 0 auto; box-sizing: border-box; }
    .head-in { display: flex; align-items: center; gap: 4px; min-height: 48px; padding: 4px 16px; }
    .back { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 6px; color: var(--text-muted); text-decoration: none; font-size: 24px; line-height: 1; }
    .back:hover { background: var(--surface-alt); color: var(--text); }
    h1 { margin: 0; font-size: 18px; }
    .layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; padding: 16px; }
    /* 索引は、ページを下へ読み進めても見えたまま（アプリのヘッダーの下に止まる） */
    .index { position: sticky; top: 68px; display: flex; flex-direction: column; gap: 2px; }
    .index a { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 10px; border-radius: 6px;
      color: var(--text); text-decoration: none; font-size: 14px; }
    .index a:hover { background: var(--surface-alt); }
    .index a.on { background: var(--surface-alt); font-weight: bold; box-shadow: inset 3px 0 0 var(--primary); }
    .index a.danger { color: var(--danger-text); }
    .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .page { min-width: 0; }
    @media (max-width: 720px) {
      .layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
      .index { position: static; flex-direction: row; overflow-x: auto; scrollbar-width: none; }
      .index::-webkit-scrollbar { display: none; }
      .index a { flex: none; white-space: nowrap; }
      .index a.on { box-shadow: inset 0 -2px 0 var(--primary); }
      .sep { display: none; }
    }
  `,
})
export class SettingsShell {
    readonly items = SETTINGS_NAV; 
    readonly crumbs = [HOME];
}