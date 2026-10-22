import { Component, computed, inject, signal } from '@angular/core';
import { TabInk } from '../../shared/tab-ink';
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
import { Crumbs, HOME } from '../../shared/crumbs';

@Component({
  selector: 'app-project-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TPipe, HelpTip, HandoverDialog,
     CsvExportDialog, ArchiveDialog, DeleteProjectDialog, Crumbs, TabInk],
  providers: [ProjectContext],
  host: { '(document:keydown.escape)': 'menuOpen.set(false)' },
  template: `@if (ctx.loading()) {
  <main><p>{{ 'common.loading' | t }}</p></main>
} @else if (ctx.notFound()) {
  <main>
    <a routerLink="/" class="back-text">{{ 'project.back' | t }}</a>
    <p>{{ 'project.notFound' | t }}</p>
  </main>
} @else {
  <!-- 名前とタブの帯（画面の横幅いっぱい。中身は main と同じ幅にそろえる） -->
  <div class="head">
    <div class="head-in">
      <div class="title-row">
        <app-crumbs [items]="crumbs">
          <h1>
            <span class="name" [title]="ctx.project()!.name">{{ ctx.project()!.name }}</span>
            <span class="role">{{ 'roles.' + ctx.role() | t }}</span>
          </h1>
        </app-crumbs>

        <div class="more">
          <button type="button" class="more-btn" [attr.aria-expanded]="menuOpen()"
            [attr.aria-label]="'project.menu' | t" [title]="'project.menu' | t" (click)="menuOpen.set(!menuOpen())"
          >⋮@if (ctx.role() === 'admin' && ctx.myRequests().length) {<span class="dot" role="img"
            [attr.aria-label]="'request.waiting' | t"></span>}</button>

          @if (menuOpen()) {
            <div class="backdrop" (click)="menuOpen.set(false)"></div>
            <div class="menu" role="menu" animate.leave="im-out">
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
              @if (ctx.project()!.settings?.features?.recurring) {
                <a role="menuitem" [routerLink]="['/p', ctx.pid(), 'recurring']" (click)="menuOpen.set(false)">
                  {{ 'recurring.menu' | t }}</a>
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

      <nav class="tabs">
        @for (t of tabs(); track t) {
          <a [routerLink]="t" routerLinkActive="on" queryParamsHandling="preserve">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="icons[t]" /></svg>
            {{ 'tabs.' + t | t }}
          </a>
        }
        <!-- 今いるタブの下の青い線（1本だけ。タブを移ると、すべって移る） -->
        <app-tab-ink />
      </nav>
    </div>
  </div>

  <main>
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

    @if (ctx.project()!.sample && !ctx.project()!.archived) {
      <div class="sample" role="status">
        <p>{{ 'sample.banner' | t }}</p>
        @if (ctx.role() === 'admin') {
          <button type="button" class="sample-end" (click)="sampleEnd.set(true); archiveOpen.set(true)">
            {{ 'sample.end' | t }}</button>
        }
      </div>
    }

    <router-outlet />
  </main>

  @if (leaveOpen() && me(); as m) {
    <app-handover-dialog mode="leave" [target]="m" (done)="leaveOpen.set(false)" (cancel)="leaveOpen.set(false)" />
  }
  @if (exportOpen()) {
    <app-csv-export-dialog (done)="exportOpen.set(false)" (cancel)="exportOpen.set(false)" />
  }
  @if (archiveOpen()) {
    <app-archive-dialog [presetReason]="sampleEnd() ? i18n.t('sample.endReason') : ''"
      (done)="archiveOpen.set(false); sampleEnd.set(false)" (cancel)="archiveOpen.set(false); sampleEnd.set(false)" />
  }
  @if (deleteOpen()) {
    <app-delete-project-dialog [pid]="ctx.pid()" [name]="ctx.project()!.name" [others]="ctx.members().length - 1"
      [prefill]="!!ctx.project()!.sample" (done)="onDeleted($event)" (cancel)="deleteOpen.set(false)" />
  }
}
  `,
  styles: `
        /* 名前とタブの帯：横幅いっぱいに線を引き、中身は main と同じ幅にそろえる */
    .head { background: var(--surface); border-bottom: 1px solid var(--border); }
    .head-in, main { max-width: 1280px; margin: 0 auto; box-sizing: border-box; }
    .head-in { padding: 6px 16px 0; }
    main { padding: 12px 16px 16px; }

    .title-row { display: flex; align-items: center; gap: 4px; min-height: 40px; }
    .back { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 6px; color: var(--text-muted); text-decoration: none; font-size: 24px; line-height: 1; }
    .back:hover { background: var(--surface-alt); color: var(--text); }
    .back-text { display: inline-flex; align-items: center; min-height: 40px; color: var(--primary); }
    h1 { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; margin: 0; font-size: 18px; }
    /* 長い名前は1行で「…」。全文は title で見られる */
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .role { flex: none; font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); font-weight: normal; }

    /* タブ：アイコン＋文字。今いるタブは太字と下の線。狭い画面では横にスクロール（バーは隠す） */
    .tabs { position: relative; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; margin-bottom: -1px; }
    .tabs::-webkit-scrollbar { display: none; }
    .tabs a { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 12px; box-sizing: border-box;
      color: var(--text-muted); text-decoration: none; font-size: 14px; white-space: nowrap;
      border-bottom: 2px solid transparent; }
    .tabs a:hover { color: var(--text); }
    .tabs a.on { color: var(--text); font-weight: bold; }
    .tabs a.on svg { color: var(--primary); }

    .more { position: relative; flex: none; }
    .more-btn { position: relative; width: 36px; height: 36px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 20px; cursor: pointer; }
    .more-btn:hover { background: var(--surface-alt); }
    .dot { position: absolute; top: 5px; right: 5px; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 200px;
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu a { padding: 0 16px; min-height: 44px; line-height: 44px; color: var(--text); text-decoration: none; font-size: 14px; }
    .menu a:hover { background: var(--surface-alt); }
    .item-row { display: flex; align-items: center; padding-right: 12px; }
    .menu button { flex: 1; text-align: left; padding: 0 16px; min-height: 44px; background: none; border: none;
      color: var(--text); font-size: 14px; cursor: pointer; }
    .menu button:hover:not(:disabled) { background: var(--surface-alt); }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .menu button.danger { color: var(--danger-text); font-weight: bold; }
    .menu button.danger:hover:not(:disabled) { background: var(--danger-bg); }
    .menu button:disabled { color: var(--text-disabled); cursor: default; }

    .archived { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; padding: 12px;
      border-radius: 8px; background: var(--surface-alt); border: 1px solid var(--border-strong); }
    .archived p { margin: 0; }
    .pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
    .archived-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .unarchive { min-height: 40px; padding: 0 16px; border: 1px solid var(--primary);
      border-radius: 8px; background: var(--surface); color: var(--primary); cursor: pointer; }
    .delete-btn { min-height: 40px; padding: 0 16px; border: 1px solid var(--danger); border-radius: 8px;
      background: var(--surface); color: var(--danger-text); font-weight: bold; cursor: pointer; }
    .delete-btn:hover:not(:disabled) { background: var(--danger-bg); }
    .error { color: var(--danger-text); }
    .sample { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; padding: 10px 12px;
      border-radius: 8px; background: var(--primary-bg); border: 1px solid var(--primary); }
    .sample p { flex: 1; min-width: 60%; margin: 0; font-size: 14px; }
    .sample-end { min-height: 40px; padding: 0 16px; border: none; border-radius: 8px; background: var(--primary);
      color: var(--on-primary); cursor: pointer; }
  `,
})
export class ProjectHome {
  protected ctx = inject(ProjectContext);
  private route = inject(ActivatedRoute);
  readonly crumbs = [HOME];
  /** プロジェクト名の横の「⋮」メニュー（削除フォルダ。今後、アーカイブ・CSV出力などもここに置く） */
  menuOpen = signal(false);
  leaveOpen = signal(false);
  exportOpen = signal(false);
  archiveOpen = signal(false);
  deleteOpen = signal(false);
  /** 見本を終えるために、アーカイブの窓を開いた（理由を最初から入れておく） */
  sampleEnd = signal(false);
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
    'overview', 'list', 'board', 'calendar',
    // ガント風表示は、管理者が設定でオンにしたときだけ（仕様メモ【14】）
    ...(this.ctx.project()?.settings?.features?.gantt ? ['gantt'] : []),
    'dashboard', 'members',
    ...(this.ctx.role() === 'admin' ? ['settings'] : []),
  ]);

  /** タブのアイコン（線の絵。1本の path で描く） */
  readonly icons: Record<string, string> = {
    overview: 'M3 10.5 12 3l9 7.5M5 9v11h14V9',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    board: 'M3 4h5v16H3zM10 4h4v10h-4zM16 4h5v13h-5z',
    calendar: 'M3 6h18v15H3zM3 10h18M8 3v4M16 3v4',
    gantt: 'M3 4v16h18M7 8h8M10 12h8M6 16h6',
    dashboard: 'M3 20h18M6 16v-5M11 16V6M16 16v-8',
    members: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21c0-4 3-6 7-6s7 2 7 6M16 3.5a4 4 0 0 1 0 7.5M22 21c0-3-1.5-5-4-5.7',
    settings: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4',
  };

  constructor() {
    // 別のプロジェクトに移ったときも読み直す
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((p) => this.ctx.load(p.get('pid')!));
  }
}