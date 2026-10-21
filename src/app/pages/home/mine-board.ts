import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { Issue, IssueStatus, Level } from '../../core/models';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { shortDue } from '../../core/time/time';
import { PriorityMark } from '../../shared/priority-mark';
import { I18nService, TPipe } from '../../i18n/i18n';
import { RecurMark } from '../../shared/recur-mark';

type Mine = Issue & { projectId: string };

/**
 * ホームの「自分の課題」のかんばん（見るだけ）。いくつものプロジェクトの課題を、ステータスの列に並べる。
 * 動かしてよいかの決まりはプロジェクトごとに違うので、ここでは動かさない（押すと課題の詳細へ）
 */
@Component({
  selector: 'app-mine-board',
  imports: [RouterLink, TPipe, PriorityMark, RecurMark],
  template: `
    <div class="board">
      @for (c of cols; track c) {
        <section class="col" [attr.data-col]="c">
          <header class="col-head">
            <span>{{ 'status.' + c | t }}</span><span class="count">{{ byCol()[c].length }}</span>
          </header>
          <div class="cards">
            @for (i of byCol()[c]; track i.id) {
              <a class="card" [routerLink]="['/p', i.projectId, 'i', i.id]" [attr.data-p]="active(i) ? prio(i) : null">
                @if (overdue(i)) { <div class="band">{{ 'board.overdue' | t }}</div> }
                <div class="body">
                  <div class="top">
                    @if (active(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> }
                    <span class="num">#{{ i.number }}</span>
                    @if (i.recurringId) { <app-recur-mark /> }
                    <span class="proj">{{ nameOf()(i.projectId) }}</span>
                  </div>
                  <span class="title">{{ i.title }}</span>
                  <span class="due" [class.overdue]="overdue(i)">{{ dueLabel(i) }}</span>
                </div>
              </a>
            } @empty {
              <p class="empty">{{ 'board.empty' | t }}</p>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: `
    .board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; margin-top: 8px; }
    .col { flex: 1 1 0; min-width: 200px; background: var(--surface-alt); border-radius: 10px;
      border-top: 4px solid var(--disabled); }
    .col[data-col='in_progress'] { border-top-color: var(--primary); }
    .col[data-col='on_hold'] { border-top-color: var(--warning); }
    .col[data-col='resolved'] { border-top-color: var(--success); }
    .col-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-weight: bold; font-size: 14px; }
    .count { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface); }
    .cards { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; min-height: 40px; }
    .card { display: block; background: var(--surface); border-radius: 8px; border-left: 4px solid var(--disabled);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); overflow: hidden; color: var(--text); text-decoration: none; }
    .card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
    .card[data-p='high'] { border-left-color: var(--danger); }
    .card[data-p='mid'] { border-left-color: var(--warning); }
    .card[data-p='low'] { border-left-color: var(--success); }
    .band { background: var(--danger-bg); color: var(--danger-text); font-size: 11px; font-weight: bold; padding: 2px 10px; }
    .body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .num { font-size: 12px; color: var(--text-muted); }
    .proj { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; color: var(--text-muted); }
    .title { font-size: 14px; overflow-wrap: anywhere; }
    .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .empty { font-size: 12px; color: var(--text-subtle); text-align: center; margin: 8px 0; }
    /* スマホ：1列ずつぴたっと止まる横スクロール */
    @media (max-width: 600px) {
      .board { scroll-snap-type: x mandatory; gap: 8px; }
      .col { flex: 0 0 85%; min-width: 0; scroll-snap-align: center; }
    }
  `,
})
export class MineBoard {
  /** 自分が担当の課題（ホームが、アーカイブ中・削除フォルダの中を除いて渡す） */
  issues = input.required<Mine[]>();
  /** プロジェクト名の引き方 */
  nameOf = input.required<(pid: string) => string>();

  private clock = inject(Clock);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 自分の課題は「まだ手が要るもの」が中心なので、完了の列は置かない */
  readonly cols: IssueStatus[] = ['open', 'in_progress', 'on_hold', 'resolved'];

  byCol = computed(() => {
    const now = this.clock.now();
    const map = Object.fromEntries(this.cols.map((c) => [c, [] as Mine[]])) as Record<string, Mine[]>;
    for (const i of this.issues()) map[i.status]?.push(i);
    for (const c of this.cols) map[c].sort((a, b) => compareIssues(a, b, now));
    return map;
  });

  active(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  overdue(i: Issue) {
    return this.active(i) && i.dueAt.toMillis() < this.clock.now();
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}