import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { DueDialog } from '../../shared/due-dialog';
import { Clock } from '../../core/time/clock';
import { Issue, Level } from '../../core/models';
import { priorityOf } from '../../core/issue/priority';
import { dateKey } from '../../core/time/time';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';

type Scale = 'day' | 'week';
/** 1日の幅（px） */
const PX: Record<Scale, number> = { day: 28, week: 8 };
const DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' を「1970-01-01 から何日目か」にする（暦の日付だけで計算するため。時差の影響を受けない） */
const dayNo = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
};
const dateOf = (n: number) => new Date(n * DAY);

interface Span { issue: Issue; start: number; end: number; }
type Row = { kind: 'group'; key: string; label: string; n: number } | ({ kind: 'issue'; key: string } & Span);

/**
 * ガント風表示。未完了の課題を、開始日から期限までの棒で並べる。
 * 依存関係の矢印や、日程の自動調整はしない（仕様メモ【14】）。データは置き場の見張りをそのまま使う
 */
@Component({
  selector: 'app-tab-gantt',
  imports: [RouterLink, TPipe, DueDialog],
  template: `
    @if (!enabled()) {
      <p class="help">{{ 'gantt.off' | t }}</p>
    } @else {
      <div class="toolbar">
        <div class="chips" role="group">
          <button type="button" [class.on]="scale() === 'day'" [attr.aria-pressed]="scale() === 'day'"
            (click)="scale.set('day')">{{ 'gantt.scaleDay' | t }}</button>
          <button type="button" [class.on]="scale() === 'week'" [attr.aria-pressed]="scale() === 'week'"
            (click)="scale.set('week')">{{ 'gantt.scaleWeek' | t }}</button>
        </div>
        <button type="button" class="today-btn" (click)="scrollToToday()">{{ 'gantt.today' | t }}</button>
        <label class="check">
          <input type="checkbox" [checked]="byAssignee()" (change)="byAssignee.set(!byAssignee())" />
          {{ 'gantt.byAssignee' | t }}
        </label>
      </div>
      <p class="help">{{ 'gantt.noDeps' | t }}</p>

      @if (ctx.issuesLoading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!rows().length) {
        <p class="help">{{ 'gantt.empty' | t }}</p>
      } @else {
        <div class="scroller" #scroller>
          <div class="chart" [style.width]="'calc(var(--left) + ' + width() + 'px)'">
            <!-- 日付の見出し -->
            <div class="row head">
              <div class="cell"></div>
              <div class="lane">
                @for (d of headDays(); track d.n) {
                  <span class="tick" [class.month]="d.month" [class.weekend]="d.weekend"
                    [style.left.px]="(d.n - range().from) * px()" [style.width.px]="d.span * px()">{{ d.label }}</span>
                }
              </div>
            </div>
            <!-- 課題の行 -->
            @for (r of rows(); track r.key) {
              @if (r.kind === 'group') {
                <div class="row group"><div class="cell">{{ r.label }}（{{ r.n }}）</div><div class="lane"></div></div>
              } @else {
                <div class="row" [class.done]="r.issue.status === 'resolved'">
                  <a class="cell" [routerLink]="['/p', ctx.pid(), 'i', r.issue.id]" [title]="r.issue.title">
                    <span class="num">#{{ r.issue.number }}</span> <span class="t">{{ r.issue.title }}</span>
                  </a>
                  <div class="lane" [style.background]="weekendBg()">
                    @if (barOf(r); as b) {
                      <div class="bar" role="link" tabindex="0" [attr.data-p]="isActive(r.issue) ? prio(r.issue) : null"
                        [class.overdue]="overdue(r.issue)" [class.moving]="drag()?.id === r.issue.id"
                        [style.left.px]="b.left" [style.width.px]="b.width" [title]="tip(r)"
                        (click)="open(r.issue)" (keydown.enter)="open(r.issue)">
                        <span class="bar-t">{{ ctx.nameOf(r.issue.assigneeId) }}</span>
                        @if (canMove(r.issue)) {
                          <span class="grip" [attr.aria-label]="'gantt.dragDue' | t" [title]="'gantt.dragDue' | t"
                            (pointerdown)="startDrag($event, r)" (pointermove)="moveDrag($event)"
                            (pointerup)="endDrag()" (pointercancel)="drag.set(null)"
                            (click)="$event.stopPropagation()"></span>
                        }
                      </div>
                      @if (drag()?.id === r.issue.id) {
                        <span class="drag-label" [style.left.px]="b.left + b.width + 6">→ {{ dragLabel() }}</span>
                      }
                    }
                  </div>
                </div>
              }
            }
            <!-- 今日の縦線 -->
            <div class="today" [style.left]="'calc(var(--left) + ' + todayLeft() + 'px)'" aria-hidden="true"></div>
          </div>
        </div>
      }
    }
    @if (pending(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pid]="ctx.pid()" [members]="ctx.members()"
        (done)="pending.set(null)" (cancel)="pending.set(null)" />
    }      
  `,
  styles: `
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 4px; }
    .chips { display: flex; gap: 4px; }
    .chips button, .today-btn { min-height: 36px; padding: 0 12px; border: 1px solid var(--border-strong);
      background: var(--surface); border-radius: 8px; font-size: 13px; cursor: pointer; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 6px 0; }
    .scroller { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
    .chart { --left: 220px; position: relative; min-width: 100%; }
    .row { display: flex; height: 36px; border-bottom: 1px solid var(--border); }
    .cell { position: sticky; left: 0; z-index: 2; flex: none; width: var(--left); box-sizing: border-box;
      display: flex; align-items: center; gap: 4px; padding: 0 8px; background: var(--surface);
      border-right: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 13px; overflow: hidden; }
    .cell .num { color: var(--text-muted); font-size: 12px; flex: none; }
    .cell .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane { position: relative; flex: 1; }
    .head { height: 28px; background: var(--surface-alt); }
    .head .cell { background: var(--surface-alt); }
    .tick { position: absolute; top: 0; bottom: 0; box-sizing: border-box; display: flex; align-items: center;
      justify-content: center; font-size: 11px; color: var(--text-muted); border-left: 1px solid var(--border);
      white-space: nowrap; overflow: hidden; }
    .tick.weekend { color: var(--danger-text); }
    .tick.month { font-weight: bold; color: var(--text); }
    .group .cell { font-weight: bold; background: var(--surface-alt); }
    .group { height: 30px; background: var(--surface-alt); }
    .bar { position: absolute; top: 8px; height: 20px; border-radius: 4px; box-sizing: border-box;
      background: var(--primary-bg); border-left: 4px solid var(--disabled); color: var(--text);
      text-decoration: none; font-size: 11px; line-height: 20px; padding: 0 6px; overflow: hidden; white-space: nowrap; }
    .bar[data-p='high'] { border-left-color: var(--danger); }
    .bar[data-p='mid'] { border-left-color: var(--warning); }
    .bar[data-p='low'] { border-left-color: var(--success); }
    .bar.overdue { background: var(--danger-bg); color: var(--danger-text); }
    .done .bar, .done .cell { opacity: 0.55; }
    .today { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--danger); z-index: 1; pointer-events: none; }
    .bar { cursor: pointer; }
    .bar.moving { outline: 2px solid var(--primary); }
    .grip { position: absolute; top: 0; right: 0; bottom: 0; width: 10px; cursor: ew-resize; touch-action: none;
      background: linear-gradient(to right, transparent, rgba(0, 0, 0, 0.18)); }
    .drag-label { position: absolute; top: 8px; z-index: 3; padding: 0 6px; border-radius: 4px; font-size: 11px;
      line-height: 20px; background: var(--text); color: var(--surface); white-space: nowrap; pointer-events: none; }    
    @media (max-width: 600px) { .chart { --left: 130px; } }
  `,
})
export class TabGantt {
  protected ctx = inject(ProjectContext);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private router = inject(Router);
  private readonly myUid = auth.currentUser!.uid;
  /** つまみを引いている最中（x＝引き始めた位置、end＝今の期限の日） */
  drag = signal<{ id: string; start: number; origEnd: number; end: number; x: number } | null>(null);
  /** 離したあと、モーダルで確かめ中の変更（カレンダーと同じモーダル） */
  pending = signal<{ issue: Issue; date: string } | null>(null);
  /** 引き終わった直後のクリックで、詳細に移らないための目印 */
  private justDragged = false;
  dragLabel = computed(() => {
    const d = this.drag();
    if (!d) return '';
    const dt = dateOf(d.end);
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  });

  scale = signal<Scale>('day');
  byAssignee = signal(false);
  enabled = computed(() => !!this.ctx.project()?.settings?.features?.gantt);
  px = computed(() => PX[this.scale()]);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  private today = computed(() => dayNo(dateKey(new Date(this.clock.now()), this.tz())));

  /** 課題ごとの、開始日と期限の日（見る人のタイムゾーンの暦で）。期限が開始日より前なら、期限の1日だけにする */
  private spans = computed<Span[]>(() => this.ctx.openIssues()
    .map((issue) => {
      const end = dayNo(dateKey(issue.dueAt.toDate(), this.tz()));
      const start = dayNo(dateKey((issue.startAt ?? issue.createdAt).toDate(), this.tz()));
      return { issue, start: Math.min(start, end), end };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.issue.number - b.issue.number));

  /** 表示する日の範囲：課題と今日が入るように、前に3日・後ろに7日の余白。長すぎないよう、今日の前180日〜後365日まで */
  range = computed(() => {
    const t = this.today();
    const sp = this.spans();
    const from = Math.max(Math.min(t, ...sp.map((x) => x.start)) - 3, t - 180);
    const to = Math.min(Math.max(t, ...sp.map((x) => x.end)) + 7, t + 365);
    return { from, to, days: to - from + 1 };
  });
  width = computed(() => this.range().days * this.px());
  todayLeft = computed(() => (this.today() - this.range().from) * this.px() + this.px() / 2);

  rows = computed<Row[]>(() => {
    const spans = this.spans();
    if (!this.byAssignee()) return spans.map((s) => ({ kind: 'issue', key: s.issue.id, ...s }));
    // 担当者ごと：名前順にまとめ、まとまりの中は開始日の順
    const groups = new Map<string, Span[]>();
    for (const s of spans) groups.set(s.issue.assigneeId, [...(groups.get(s.issue.assigneeId) ?? []), s]);
    return [...groups.entries()]
      .map(([uid, list]) => ({ uid, name: this.ctx.nameOf(uid), list }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((g) => [
        { kind: 'group' as const, key: 'g-' + g.uid, label: g.name, n: g.list.length },
        ...g.list.map((s) => ({ kind: 'issue' as const, key: s.issue.id, ...s })),
      ]);
  });

  /** 見出しの目盛り。日の縮尺は1日ずつ、週の縮尺は日曜ごと（どちらも月の初めは太字で月を出す） */
  headDays = computed(() => {
    const { from, to } = this.range();
    const week = this.scale() === 'week';
    const out: { n: number; span: number; label: string; month: boolean; weekend: boolean }[] = [];
    for (let n = from; n <= to; n++) {
      const d = dateOf(n);
      const dow = d.getUTCDay();
      const first = d.getUTCDate() === 1;
      if (week && dow !== 0 && n !== from) continue;
      const span = week ? Math.min(7 - (n === from ? dow : 0), to - n + 1) : 1;
      out.push({
        n, span,
        label: first || n === from ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : String(d.getUTCDate()),
        month: first,
        weekend: !week && (dow === 0 || dow === 6),
      });
    }
    return out;
  });

  /** 土日の薄い色（行ごとに要素を増やさず、背景の縞で描く） */
  weekendBg = computed(() => {
    const px = this.px();
    // 範囲の最初の日から、次の土曜日までの日数（そこから2日分が土日）
    const toSat = (6 - dateOf(this.range().from).getUTCDay() + 7) % 7;
    return `repeating-linear-gradient(to right, transparent 0 ${5 * px}px, var(--surface-alt) ${5 * px}px ${7 * px}px)`
      + ` ${(toSat - 5) * px}px 0 / ${7 * px}px 100%`;
  });

  constructor() {
    // 開いたときと縮尺を変えたときに、今日が見える位置までスクロールする
    effect(() => {
      this.scale();
      if (!this.scroller() || !this.rows().length) return;
      untracked(() => setTimeout(() => this.scrollToToday()));
    });
  }

  scrollToToday() {
    const el = this.scroller()?.nativeElement;
    if (el) el.scrollLeft = Math.max(0, this.todayLeft() - el.clientWidth / 3);
  }

  // ---- 期限のドラッグ（右端のつまみ） ----

  /** 引けるのは、管理者・提起者・担当者で、クローズ前（ルールの editAllowed・カレンダーと同じ） */
  canMove(i: Issue) {
    if (i.status === 'closed' || this.ctx.archived()) return false;
    const r = this.ctx.role();
    return r === 'admin' || (r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid));
  }

  /** 引き始め。指やマウスがつまみの外に出ても追えるよう、つまみに「つかんだ」と知らせる */
  startDrag(e: PointerEvent, r: Span) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.drag.set({ id: r.issue.id, start: r.start, origEnd: r.end, end: r.end, x: e.clientX });
  }

  /** 動かした距離を、日の数に直す（開始日より前にはしない＝棒は最短で1日） */
  moveDrag(e: PointerEvent) {
    const d = this.drag();
    if (!d) return;
    const end = Math.max(d.start, d.origEnd + Math.round((e.clientX - d.x) / this.px()));
    if (end !== d.end) this.drag.set({ ...d, end });
  }

  /** 離したら、日が変わっていればモーダルで確かめる（理由を書いて確定。元に戻すもモーダルが出す） */
  endDrag() {
    const d = this.drag();
    if (!d) return;
    this.drag.set(null);
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false));
    const issue = this.ctx.openIssues().find((i) => i.id === d.id);
    if (issue && d.end !== d.origEnd) {
      this.pending.set({ issue, date: dateOf(d.end).toISOString().slice(0, 10) });
    }
  }

  open(i: Issue) {
    if (this.justDragged) return;
    this.router.navigate(['/p', this.ctx.pid(), 'i', i.id]);
  }  

  /** 棒の位置と幅（範囲の外にはみ出した分は切る。全部が外なら出さない） */
  barOf(r: Span) {
    const { from, to } = this.range();
    const d = this.drag();
    const end = d?.id === r.issue.id ? d.end : r.end;
    const s = Math.max(r.start, from);
    const e = Math.min(end, to);
    if (e < s) return null;
    return { left: (s - from) * this.px(), width: (e - s + 1) * this.px() };
  }

  tip(r: Span) {
    const fmt = (n: number) => dateOf(n).toISOString().slice(0, 10).replace(/-/g, '/');
    return `#${r.issue.number} ${r.issue.title}\n${fmt(r.start)} 〜 ${fmt(r.end)}・${this.ctx.nameOf(r.issue.assigneeId)}`;
  }

  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  overdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
}