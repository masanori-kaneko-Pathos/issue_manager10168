import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectContext } from '../../core/project-context';
import { TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-project-home',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe],
  providers: [ProjectContext],
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'project.back' | t }}</a></header>
    <main>
      @if (ctx.loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (ctx.notFound()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        <h1>{{ ctx.project()!.name }} <span class="role">{{ 'roles.' + ctx.role() | t }}</span></h1>
        <nav class="tabs">
          @for (t of tabs; track t) {
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
    h1 { font-size: 20px; margin: 0 0 12px; }
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

  /** タブの並び。カレンダーなどは、作ったらここに足す */
  readonly tabs = ['list', 'members'];

  constructor() {
    // 別のプロジェクトに移ったときも読み直す
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => this.ctx.load(p.get('pid')!));
  }
}