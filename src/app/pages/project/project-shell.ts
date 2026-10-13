import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectContext } from './project-context';
import { TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-project-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe],
  providers: [ProjectContext],
  host: { '(document:keydown.escape)': 'menuOpen.set(false)' },
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'project.back' | t }}</a></header>
    <main>
      @if (ctx.loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (ctx.notFound()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        <div class="title-row">
          <h1>{{ ctx.project()!.name }} <span class="role">{{ 'roles.' + ctx.role() | t }}</span></h1>
          <div class="more">
            <button type="button" class="more-btn" [attr.aria-expanded]="menuOpen()"
              [attr.aria-label]="'project.menu' | t" [title]="'project.menu' | t"
              (click)="menuOpen.set(!menuOpen())">⋮</button>
            @if (menuOpen()) {
              <div class="backdrop" (click)="menuOpen.set(false)"></div>
              <div class="menu" role="menu">
                <a role="menuitem" [routerLink]="['/p', ctx.pid(), 'trash']" (click)="menuOpen.set(false)">
                  {{ 'trash.title' | t }}</a>
              </div>
            }
          </div>
        </div>
        <nav class="tabs">
          @for (t of tabs(); track t) {
            <a [routerLink]="t" routerLinkActive="on" queryParamsHandling="preserve">{{ 'tabs.' + t | t }}</a>
          }
        </nav>
        <router-outlet />
      }
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    .link { color: var(--primary); }
    main { max-width: 960px; margin: 0 auto; padding: 16px; }
    .title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    h1 { flex: 1; font-size: 20px; margin: 0; overflow-wrap: anywhere; }
    .more { position: relative; }
    .more-btn { width: 40px; height: 40px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 20px; cursor: pointer; }
    .more-btn:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 200px;
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu a { padding: 0 16px; min-height: 44px; line-height: 44px; color: var(--text);
      text-decoration: none; font-size: 14px; }
    .menu a:hover { background: var(--surface-alt); }
    .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); font-weight: normal; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
    .tabs a { padding: 10px 16px; min-height: 44px; box-sizing: border-box; text-decoration: none;
      color: var(--text-muted); border-bottom: 3px solid transparent; white-space: nowrap; }
    .tabs a.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: bold; }
  `,
})
export class ProjectHome {
  protected ctx = inject(ProjectContext);
  private route = inject(ActivatedRoute);
  /** プロジェクト名の横の「⋮」メニュー（削除フォルダ。今後、アーカイブ・CSV出力などもここに置く） */
  menuOpen = signal(false);

  /** タブの並び。設定は管理者だけに出す */
  tabs = computed(() =>
    this.ctx.role() === 'admin'
      ? ['list', 'board', 'calendar', 'members', 'settings']
      : ['list', 'board', 'calendar', 'members']);

  constructor() {
    // 別のプロジェクトに移ったときも読み直す
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => this.ctx.load(p.get('pid')!));
  }
}