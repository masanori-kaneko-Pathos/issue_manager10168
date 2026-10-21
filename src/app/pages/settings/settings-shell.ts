import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SideIndex } from '../../shared/side-index';
import { TPipe } from '../../i18n/i18n';
import { SETTINGS_NAV } from '../../shared/settings-nav';
import { Crumbs, HOME } from '../../shared/crumbs';

/** 設定の入れ物：上に「‹ 設定」の帯、左に索引、右に各ページ（GitHub の設定と同じ形）。スマホは索引を上に横並び */
@Component({
  selector: 'app-settings-shell',
  imports: [RouterOutlet, TPipe, Crumbs, SideIndex],
  template: `
    <div class="head">
      <div class="head-in">
        <app-crumbs [items]="crumbs"><h1>{{ 'settings.title' | t }}</h1></app-crumbs>
      </div>
    </div>
    <div class="layout">
      <app-side-index [items]="items" label="settings.title" />
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
    .page { min-width: 0; }
    @media (max-width: 720px) {
      .layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    }
  `,
})
export class SettingsShell {
    readonly items = SETTINGS_NAV; 
    readonly crumbs = [HOME];
}