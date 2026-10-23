import { Component, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { auth } from '../core/firebase';
import { Draft, DraftService } from '../core/draft/draft.service';
import { DraftsWindow } from '../core/draft/drafts-window.service';
import { ProjectService } from '../core/project/project.service';
import { UndoService } from '../core/undo/undo.service';
import { IssueFormService } from '../core/issue/issue-form.service';
import { Clock } from '../core/time/clock';
import { relativeTime } from '../core/time/time';
import { I18nService, TPipe } from '../i18n/i18n';
import { ProjectNewDialog } from './project-new-dialog';

/**
 * 下書きの窓（app.html に1つ）。軽い一覧なので、ページではなく窓（リマインドと同じ）。
 * 外・Esc・✕ で閉じ、画面を移ると閉じる。?drafts=1 で来たら開いて、その印を消す（古い /drafts のリンクも、ここに来る）
 */
@Component({
  selector: 'app-drafts-host',
  imports: [TPipe, ProjectNewDialog],
  host: { '(document:keydown.escape)': 'onEsc()' },
  template: `
    @if (win.open()) {
      <div class="layer" animate.leave="im-out-dialog">
        <div class="backdrop" (click)="win.open.set(false)"></div>
        <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'drafts.title' | t">
          <div class="head">
            <h2>{{ 'drafts.title' | t }}</h2>
            <button type="button" class="icon-btn" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t"
              (click)="win.open.set(false)">✕</button>
          </div>
          <p class="help">{{ 'drafts.help' | t }}</p>
          <ul class="list">
            @for (d of drafts.drafts(); track d.id) {
              <li class="r">
                <button type="button" class="item" (click)="open(d)">
                  <span class="kind">{{ 'drafts.kinds.' + d.kind | t }}</span>
                  <span class="title" [class.untitled]="!d.title">{{ d.title || ('drafts.untitled' | t) }}</span>
                  <span class="meta">
                    @if (projectName(d); as name) { <span>{{ name }} · </span> }{{ 'inbox.editedAgo' | t: { t: when(d) } }}
                  </span>
                </button>
                <!-- PC は行に乗せたときだけ、スマホはいつも出す -->
                <button type="button" class="del" [title]="'drafts.delete' | t" [attr.aria-label]="'drafts.delete' | t"
                  (click)="remove(d)">
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
                </button>
              </li>
            } @empty {
              <li class="empty">{{ 'drafts.empty' | t }}</li>
            }
          </ul>
        </section>
      </div>
    }
    @if (projectDraft(); as id) {
      @defer (on immediate) {
        <app-project-new-dialog [draftId]="id" (close)="projectDraft.set(null)" />
      }
    }
  `,
  styles: `
    .layer { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .head { display: flex; align-items: center; gap: 4px; }
    .head h2 { flex: 1; }
    .icon-btn { flex: none; width: 36px; height: 36px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 18px; cursor: pointer; }
    .icon-btn:hover { background: var(--surface-alt); color: var(--text); }
    .list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
    .r { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--border); }
    .r:hover { background: var(--surface-alt); }
    .item { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; text-align: left;
      background: none; border: none; color: var(--text); font: inherit; cursor: pointer; }
    .kind { align-self: flex-start; font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--chip-bg); }
    .title { font-size: 15px; overflow-wrap: anywhere; }
    .title.untitled { color: var(--text-muted); }
    .meta { font-size: 12px; color: var(--text-muted); }
    .del { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; background: none; color: var(--text-muted); cursor: pointer; }
    .del:hover { background: var(--surface-muted); color: var(--danger-text); }
    @media (hover: hover) and (pointer: fine) {
      .del { opacity: 0; }
      .r:hover .del, .r:focus-within .del { opacity: 1; }
    }
    .empty { padding: 16px 8px; color: var(--text-muted); font-size: 14px; }
  `,
})
export class DraftsHost {
  protected win = inject(DraftsWindow);
  protected drafts = inject(DraftService);
  private ps = inject(ProjectService);
  private undo = inject(UndoService);
  private issueForm = inject(IssueFormService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  /** プロジェクト名を引くための表（読めなくても、名前が出ないだけ） */
  private names = signal(new Map<string, string>());
  /** 開いているプロジェクトの下書き（作成の窓を、この下書きを入れて開く） */
  projectDraft = signal<string | null>(null);

  constructor() {
    const router = inject(Router);
    router.events.pipe(filter((e) => e instanceof NavigationStart), takeUntilDestroyed())
      .subscribe(() => this.win.open.set(false));
    // ?drafts=1 で来たら：先に印を消してから開く（消す移動で閉じてしまわないように、移動が済んでから）
    router.events.pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => {
        if (router.parseUrl(router.url).queryParams['drafts'] !== '1') return;
        router.navigate([], { queryParams: { drafts: null }, queryParamsHandling: 'merge', replaceUrl: true })
          .then(() => this.win.open.set(true));
      });
    // 開くたびに、プロジェクト名を読み直す（参加・作成・名前の変更が、すぐ出るように）
    effect(() => {
      if (this.win.open()) untracked(() => this.loadNames());
    });
  }

  private async loadNames() {
    try {
      const list = await this.ps.listMyProjects(auth.currentUser!.uid);
      this.names.set(new Map(list.map((p) => [p.id, p.name])));
    } catch (e) {
      console.error(e);
    }
  }

  projectName(d: Draft) {
    return d.pid ? this.names().get(d.pid) ?? '' : '';
  }

  when(d: Draft) {
    return relativeTime(d.updatedAt, this.i18n.lang(), this.clock.now());
  }

  /** 続きを書く：この窓を閉じて、課題は登録の窓、プロジェクトは作成の窓を開く */
  open(d: Draft) {
    this.win.open.set(false);
    if (d.kind === 'issue') this.issueForm.open(d.pid, { draft: d.id });
    else this.projectDraft.set(d.id);
  }

  /** 消す。元に戻すで、同じ中身をしまい直せる（戻せる操作なので、確認の窓は出さない） */
  remove(d: Draft) {
    this.drafts.remove(d.id);
    this.undo.offer('drafts.deleted', {}, async () => this.drafts.save(d));
  }

  onEsc() {
    if (this.win.open()) this.win.open.set(false);
  }
}