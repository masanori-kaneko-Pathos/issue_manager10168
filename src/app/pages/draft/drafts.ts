import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { Draft, DraftService } from '../../core/draft/draft.service';
import { ProjectService } from '../../core/project/project.service';
import { UndoService } from '../../core/undo/undo.service';
import { Clock } from '../../core/time/clock';
import { relativeTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { ProjectNewDialog } from '../../shared/project-new-dialog';

/** 下書きの一覧（新しく作るものの書きかけ。この端末にだけ残る） */
@Component({
  selector: 'app-drafts',
  imports: [RouterLink, TPipe, ProjectNewDialog],
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'common.back' | t }}</a></header>
    <main>
      <h1>{{ 'drafts.title' | t }}</h1>
      <p class="help">{{ 'drafts.help' | t }}</p>
      <ul class="list">
        @for (d of drafts.drafts(); track d.id) {
          <li class="row">
            <button type="button" class="item" (click)="open(d)">
              <span class="kind">{{ 'drafts.kinds.' + d.kind | t }}</span>
              <span class="title" [class.untitled]="!d.title">{{ d.title || ('drafts.untitled' | t) }}</span>
              <span class="meta">
                @if (projectName(d); as name) { <span>{{ name }} · </span> }{{ 'inbox.editedAgo' | t: { t: when(d) } }}
              </span>
            </button>
            <!-- PC は行に乗せたときだけ、スマホはいつも出す（受信箱のページと同じ） -->
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
    </main>
        @if (projectDraft(); as id) {
      <app-project-new-dialog [draftId]="id" (close)="projectDraft.set(null)" />
    }
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    .link { color: var(--primary); }
    main { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
    .list { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
    .row { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--border); }
    .row:hover { background: var(--surface-alt); }
    .item { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; text-align: left;
      background: none; border: none; color: var(--text); cursor: pointer; }
    .kind { align-self: flex-start; font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--chip-bg); }
    .title { font-size: 15px; overflow-wrap: anywhere; }
    .title.untitled { color: var(--text-muted); }
    .meta { font-size: 12px; color: var(--text-muted); }
    .del { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; background: none; color: var(--text-muted); cursor: pointer; }
    .del:hover { background: var(--surface-muted); color: var(--danger-text); }
    /* マウスを乗せられる端末だけ：ふだんは隠し、乗せた行（キーボードで移った行も）で出す */
    @media (hover: hover) and (pointer: fine) {
      .del { opacity: 0; }
      .row:hover .del, .row:focus-within .del { opacity: 1; }
    }
    .empty { padding: 16px 8px; color: var(--text-muted); font-size: 14px; }
  `,
})
export class Drafts implements OnInit {
  protected drafts = inject(DraftService);
  private ps = inject(ProjectService);
  private undo = inject(UndoService);
  private router = inject(Router);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  /** プロジェクト名を引くための表（読めなくても、名前が出ないだけ） */
  private names = signal(new Map<string, string>());
  /** 開いているプロジェクトの下書き（作成の窓を、この下書きを入れて開く） */
  projectDraft = signal<string | null>(null);

  async ngOnInit() {
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

  /** 続きを書く：課題は登録画面へ、プロジェクトは作成の窓をこのページの上に開く */
  open(d: Draft) {
    if (d.kind === 'issue') this.router.navigate(['/new'], { queryParams: { draft: d.id } });
    else this.projectDraft.set(d.id);
  }

  /** 消す。元に戻すで、同じ中身をしまい直せる（戻せる操作なので、確認の窓は出さない） */
  remove(d: Draft) {
    this.drafts.remove(d.id);
    this.undo.offer('drafts.deleted', {}, async () => this.drafts.save(d));
  }
}