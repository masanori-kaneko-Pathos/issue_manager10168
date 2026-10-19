import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectContext } from './project-context';
import { TPipe, I18nService } from '../../i18n/i18n';
import { auth } from '../../core/firebase';
import { HelpTip } from '../../shared/help-tip';
import { HandoverDialog } from './handover-dialog';
import { CsvExportDialog } from './csv-export-dialog';
import { ArchiveDialog } from './archive-dialog';
import { ProjectService } from '../../core/project/project.service';
import { DeleteProjectDialog } from './delete-project-dialog';

@Component({
  selector: 'app-project-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe, HelpTip, HandoverDialog,
     CsvExportDialog, ArchiveDialog, DeleteProjectDialog],
  providers: [ProjectContext],
  host: { '(document:keydown.escape)': 'menuOpen.set(false)' },
  template: `
<header class="bar">
  <a routerLink="/" class="link">{{ 'project.back' | t }}</a>
</header>

<main>
  @if (ctx.loading()) {
    <p>{{ 'common.loading' | t }}</p>
  } @else if (ctx.notFound()) {
    <p>{{ 'project.notFound' | t }}</p>
  } @else {
    <div class="title-row">
      <h1>
        {{ ctx.project()!.name }}
        <span class="role">{{ 'roles.' + ctx.role() | t }}</span>
      </h1>

      <div class="more">
        <button
          type="button"
          class="more-btn"
          [attr.aria-expanded]="menuOpen()"
          [attr.aria-label]="'project.menu' | t"
          [title]="'project.menu' | t"
          (click)="menuOpen.set(!menuOpen())"
        >⋮@if (ctx.role() === 'admin' && ctx.myRequests().length) {<span class="dot" role="img"
          [attr.aria-label]="'request.waiting' | t"></span>}</button>

        @if (menuOpen()) {
          <div class="backdrop" (click)="menuOpen.set(false)"></div>

          <div class="menu" role="menu">
            <a role="menuitem" [routerLink]="['/p', ctx.pid(), 'trash']" (click)="menuOpen.set(false)">
              {{ 'trash.title' | t }}</a>

            @if (ctx.role() !== 'viewer') {
              <a role="menuitem" [routerLink]="['/p', ctx.pid(), 'requests']" (click)="menuOpen.set(false)">
                {{ 'request.menu' | t: { n: '' + ctx.myRequests().length } }}</a>
            }

            @if (ctx.role() !== 'viewer' && !ctx.project()!.archived) {
              <a role="menuitem" [routerLink]="['/p', ctx.pid(), 'import']" (click)="menuOpen.set(false)">
                {{ 'importPage.open' | t }}</a>
            }

            <!-- CSV はだれでも・アーカイブ中でも書き出せる -->
            <button type="button" role="menuitem" (click)="menuOpen.set(false); exportOpen.set(true)">
              {{ 'csv.export' | t }}</button>

            <!-- ここから下は、プロジェクトとの関係を変える操作 -->
            <div class="sep" role="separator"></div>

            @if (ctx.role() === 'admin' && !ctx.project()!.archived) {
              <button type="button" role="menuitem" (click)="menuOpen.set(false); archiveOpen.set(true)">
                {{ 'archive.open' | t }}</button>
            }

            <div class="item-row">
              <button type="button" role="menuitem" class="danger" [disabled]="ctx.role() === 'admin'"
                (click)="menuOpen.set(false); leaveOpen.set(true)">{{ 'members.leave' | t }}</button>
              @if (ctx.role() === 'admin') {
                <app-help-tip kind="denied" align="right" [keys]="['members.leaveAdmin']" />
              }
            </div>
          </div>
        }
      </div>
    </div>

    @if (ctx.project()!.archived) {
      <div class="archived" role="status">
        <p><strong>{{ 'archive.banner' | t: { kind: i18n.t('archive.kinds.' + (ctx.project()!.archiveKind ?? 'completed')) } }}</strong></p>
        @if (ctx.project()!.archiveReason; as r) { <p class="pre">{{ 'archive.bannerReason' | t: { reason: r } }}</p> }
        @if (ctx.role() === 'admin') {
          <div class="archived-actions">
            <button type="button" class="unarchive" [disabled]="busy()" (click)="unarchive()">{{ 'archive.unarchive' | t }}</button>
            <button type="button" class="delete-btn" [disabled]="busy()" (click)="deleteOpen.set(true)">
              {{ 'deleteProject.open' | t }}</button>
          </div>
        }
        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      </div>
    }

    <nav class="tabs">
      @for (t of tabs(); track t) {
        <a
          [routerLink]="t"
          routerLinkActive="on"
          queryParamsHandling="preserve"
        >
          {{ 'tabs.' + t | t }}
        </a>
      }
    </nav>

    <router-outlet />

    @if (leaveOpen() && me(); as m) {
      <app-handover-dialog
        mode="leave"
        [target]="m"
        (done)="leaveOpen.set(false)"
        (cancel)="leaveOpen.set(false)"
      />
    }

    @if (exportOpen()) {
      <app-csv-export-dialog
        (done)="exportOpen.set(false)"
        (cancel)="exportOpen.set(false)"
      />
    }

    @if (archiveOpen()) {
      <app-archive-dialog
        (done)="archiveOpen.set(false)"
        (cancel)="archiveOpen.set(false)"
      />
    }

    @if (deleteOpen()) {
      <app-delete-project-dialog
        [pid]="ctx.pid()"
        [name]="ctx.project()!.name"
        [others]="ctx.members().length - 1"
        (done)="onDeleted($event)"
        (cancel)="deleteOpen.set(false)"
      />
    }
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
      .item-row { display: flex; align-items: center; padding-right: 12px; }
    .menu button { flex: 1; text-align: left; padding: 0 16px; min-height: 44px; background: none; border: none;
      font-size: 14px; cursor: pointer; }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .menu button.danger { color: var(--danger-text); font-weight: bold; }
    .menu button.danger:hover:not(:disabled) { background: var(--danger-bg); }
    .menu button:disabled { color: var(--text-disabled); cursor: default; }
    .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); font-weight: normal; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
    .tabs a { padding: 10px 16px; min-height: 44px; box-sizing: border-box; text-decoration: none;
      color: var(--text-muted); border-bottom: 3px solid transparent; white-space: nowrap; }
    .tabs a.on { color: var(--primary); border-bottom-color: var(--primary); font-weight: bold; }
    .archived { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; padding: 12px;
      border-radius: 8px; background: var(--surface-alt); border: 1px solid var(--border-strong); }
    .archived p { margin: 0; }
    .pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
    .unarchive { align-self: flex-start; min-height: 40px; padding: 0 16px; border: 1px solid var(--primary);
      border-radius: 8px; background: var(--surface); color: var(--primary); cursor: pointer; }
    .error { color: var(--danger-text); }
    .archived-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .delete-btn { min-height: 40px; padding: 0 16px; border: 1px solid var(--danger); border-radius: 8px;
      background: var(--surface); color: var(--danger-text); font-weight: bold; cursor: pointer; }
    .delete-btn:hover:not(:disabled) { background: var(--danger-bg); }
    .more-btn { position: relative; }
    .dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%;
      background: var(--danger); }    
  `,
})
export class ProjectHome {
  protected ctx = inject(ProjectContext);
  private route = inject(ActivatedRoute);
  /** プロジェクト名の横の「⋮」メニュー（削除フォルダ。今後、アーカイブ・CSV出力などもここに置く） */
  menuOpen = signal(false);
  leaveOpen = signal(false);
  exportOpen = signal(false);
  archiveOpen = signal(false);
  deleteOpen = signal(false);
  busy = signal(false);
  error = signal('');
  protected i18n = inject(I18nService);
  private ps = inject(ProjectService);

  /** アーカイブを解除する（元に戻せる操作なので、確認はしない） */
  async unarchive() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.unarchive(this.ctx.pid(), auth.currentUser!.uid, this.ctx.role()!);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  private router = inject(Router);

  /** 消し終わったら、ホームへ戻って知らせる */
  onDeleted(name: string) {
    this.router.navigate(['/'], { replaceUrl: true, state: { deletedProject: name, byMe: true } });
  }

  /** 自分のメンバー文書（抜けるときの引き継ぎに使う） */
  me = computed(() => this.ctx.members().find((m) => m.uid === auth.currentUser!.uid) ?? null);

  /** タブの並び。設定は管理者だけに出す */
  tabs = computed(() => [
    'list', 'board', 'calendar',
    // ガント風表示は、管理者が設定でオンにしたときだけ（仕様メモ【14】）
    ...(this.ctx.project()?.settings?.features?.gantt ? ['gantt'] : []),
    'dashboard', 'members',
    ...(this.ctx.role() === 'admin' ? ['settings'] : []),
  ]);

  constructor() {
    // 別のプロジェクトに移ったときも読み直す
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => this.ctx.load(p.get('pid')!));
  }
}