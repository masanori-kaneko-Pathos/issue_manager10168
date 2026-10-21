import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { ProjectService } from '../core/project/project.service';
import { PROJECT_FOLD, orderProjects } from '../core/project/project-order';
import { InboxService } from '../core/inbox/inbox.service';
import { DraftService } from '../core/draft/draft.service';
import { ProjectWithRole } from '../core/models';
import { TPipe } from '../i18n/i18n';

/**
 * 引き出し（ヘッダーの ☰ から、左からすっと出る）。ホーム・受信箱・下書き・プロジェクトへの近道。
 * お知らせと設定は、ヘッダーに入口があるので入れない（入口は1か所）。行き先を押す・外・Esc で閉じる
 */
@Component({
  selector: 'app-nav-drawer',
  imports: [RouterLink, TPipe],
  host: { '(document:keydown.escape)': 'close.emit()' },
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <nav class="drawer" role="dialog" aria-modal="true" [attr.aria-label]="'nav.title' | t">
      <div class="d-head">
        <span class="brand">{{ 'app.title' | t }}</span>
        <button type="button" class="x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t"
          (click)="close.emit()">✕</button>
      </div>

      <a routerLink="/" class="item" (click)="close.emit()">{{ 'crumbs.home' | t }}</a>
      <a routerLink="/inbox" class="item" (click)="close.emit()">
        <span class="grow">{{ 'inbox.title' | t }}</span>
        @if (inbox.count()) { <span class="n">{{ inbox.count() }}</span> }</a>
      @if (drafts.count()) {
        <a routerLink="/drafts" class="item" (click)="close.emit()">
          <span class="grow">{{ 'drafts.title' | t }}</span><span class="n">{{ drafts.count() }}</span></a>
      }

      <div class="sep" role="separator"></div>
      <p class="label">{{ 'projects.title' | t }}</p>
      @if (loading()) {
        <p class="small">{{ 'common.loading' | t }}</p>
      } @else {
        @for (p of shown(); track p.id) {
          <a class="item" [routerLink]="['/p', p.id]" [title]="p.name" (click)="close.emit()">
            @if (pins().has(p.id)) {
              <svg class="pin" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"
                stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                <path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>
            }
            <span class="grow pname">{{ p.name }}</span>
            <span class="role">{{ 'roles.' + p.role | t }}</span></a>
        } @empty {
          <p class="small">{{ 'projects.empty' | t }}</p>
        }
        @if (active().length > fold) {
          <button type="button" class="more" (click)="showAll.set(!showAll())">
            {{ (showAll() ? 'projects.showLess' : 'projects.showMore') | t: { n: '' + (active().length - fold) } }}</button>
        }
      }
    </nav>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 左からすっと出る（閉じるときはすぐ消える） */
    @keyframes drawer-in { from { translate: -100% 0; } }
    .drawer { position: absolute; top: 0; bottom: 0; left: 0; width: min(300px, 85vw); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
      padding: 8px 8px calc(16px + env(safe-area-inset-bottom)); background: var(--surface); color: var(--text);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.2); animation: drawer-in 220ms var(--ease-out); }
    .d-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px 12px; }
    .brand { font-weight: bold; font-size: 16px; }
    .x { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--text-muted);
      font-size: 18px; cursor: pointer; }
    .x:hover { background: var(--surface-alt); }
    .item { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-radius: 8px;
      color: var(--text); text-decoration: none; font-size: 15px; }
    .item:hover { background: var(--surface-alt); }
    .grow { flex: 1; min-width: 0; }
    .pname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin { flex: none; color: var(--primary); }
    .n { flex: none; font-size: 12px; padding: 0 8px; border-radius: 10px; background: var(--surface-alt); color: var(--text-muted); }
    .role { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--chip-bg); }
    .sep { height: 1px; margin: 8px 4px; background: var(--border); }
    .label { margin: 4px 12px; font-size: 12px; color: var(--text-muted); }
    .small { margin: 4px 12px; font-size: 13px; color: var(--text-muted); }
    .more { align-self: flex-start; min-height: 40px; padding: 0 12px; border: none; background: none;
      color: var(--primary); font-size: 14px; cursor: pointer; }
  `,
})
export class NavDrawer implements OnInit {
  close = output<void>();

  protected inbox = inject(InboxService);
  protected drafts = inject(DraftService);
  private authService = inject(AuthService);
  private ps = inject(ProjectService);

  readonly fold = PROJECT_FOLD;
  private projects = signal<ProjectWithRole[]>([]);
  loading = signal(true);
  showAll = signal(false);

  pins = computed(() => new Set(this.authService.profile()?.pinnedProjects ?? []));
  /** ホームと同じ並び（ピン止めが上・名前順。アーカイブ済みは除く） */
  active = computed(() => orderProjects(this.projects(), this.authService.profile()?.pinnedProjects));
  shown = computed(() => (this.showAll() ? this.active() : this.active().slice(0, this.fold)));

  /** 開くたびに一覧を読む（参加・作成・ピン止めが、すぐ反映されるように） */
  async ngOnInit() {
    try {
      this.projects.set(await this.ps.listMyProjects(auth.currentUser!.uid));
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }
}