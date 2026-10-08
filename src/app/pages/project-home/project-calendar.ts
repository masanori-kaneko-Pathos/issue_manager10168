import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { auth } from '../../core/firebase';
import { DueDialog } from '../../shared/due-dialog';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { IssueService } from '../../core/issue.service';
import { Issue, Level } from '../../core/models';
import { compareIssues, priorityOf } from '../../core/priority';
import { ProjectContext } from '../../core/project-context';
import { dateKey } from '../../core/time';
import { I18nService, TPipe } from '../../i18n/i18n';

type Mode = 'month' | 'week';
interface Day { key: string; d: number; dow: number; inRange: boolean; }

/** 'YYYY-MM-DD' を、UTCの「日付だけ」の Date にする（日付の計算専用） */
function toUTC(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
/** UTCの「日付だけ」の Date を 'YYYY-MM-DD' に戻す */
function keyOf(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
function addDays(dt: Date, n: number): Date {
  const x = new Date(dt);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

@Component({
  selector: 'app-project-calendar',
  imports: [RouterLink, TPipe, CdkDropListGroup, CdkDropList, CdkDrag, DueDialog],
  template: `
    <div class="toolbar">
      <div class="nav">
        <button type="button" (click)="move(-1)" [attr.aria-label]="'calendar.prev' | t">‹</button>
        <button type="button" (click)="goToday()">{{ 'calendar.today' | t }}</button>
        <button type="button" (click)="move(1)" [attr.aria-label]="'calendar.next' | t">›</button>
      </div>
      <h2>{{ title() }}</h2>
      <div class="modes">
        <button type="button" [class.on]="mode() === 'month'" (click)="setMode('month')">{{ 'calendar.month' | t }}</button>
        <button type="button" [class.on]="mode() === 'week'" (click)="setMode('week')">{{ 'calendar.week' | t }}</button>
      </div>
    </div>

    @if (loading()) {
      <p>{{ 'common.loading' | t }}</p>
    } @else {
      <div class="grid" [class.week]="mode() === 'week'" cdkDropListGroup>
        @for (w of weekdays(); track $index) {
          <div class="dow" [class.sun]="$index === 0" [class.sat]="$index === 6">{{ w }}</div>
        }
        @for (day of days(); track day.key) {
          @let items = byDay().get(day.key) ?? [];
          <div class="cell" [class.out]="!day.inRange" [class.today]="day.key === todayKey()"
            [class.sun]="day.dow === 0" [class.sat]="day.dow === 6" (click)="onCellTap(day.key)"
            cdkDropList [cdkDropListData]="day.key" [cdkDropListSortingDisabled]="true"
            (cdkDropListDropped)="onDrop($event)"
            [class.drop-future]="!!dragging() && day.key >= todayKey()"
            [class.drop-past]="!!dragging() && day.key < todayKey()">
            <div class="cell-head">
              <span class="date">{{ day.d }}</span>
              @if (items.length) { <span class="count">{{ items.length }}</span> }
              @if (ctx.canCreate()) {
                <a class="add" [routerLink]="['/p', ctx.pid(), 'new']" [queryParams]="{ due: day.key }"
                  [attr.aria-label]="'calendar.addOn' | t: { date: day.key }" (click)="$event.stopPropagation()">＋</a>
              }
            </div>
            <div class="items">
              @for (i of (mode() === 'week' ? items : items.slice(0, 3)); track i.id) {
                <div class="item" role="link" tabindex="0" [attr.data-p]="prio(i)" [class.overdue]="isOverdue(i)"
                  [class.resolved]="i.status === 'resolved'" [title]="i.title"
                  cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canMove(i)" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                  (cdkDragStarted)="dragging.set(i)" (cdkDragEnded)="onDragEnded()"
                  (click)="open(i); $event.stopPropagation()" (keydown.enter)="open(i)">
                  <span class="num">#{{ i.number }}</span> {{ i.title }}
                </div>
              }
              @if (mode() === 'month' && items.length > 3) {
                <button type="button" class="more" (click)="openWeek(day.key); $event.stopPropagation()">
                  +{{ items.length - 3 }}</button>
              }
            </div>
          </div>
        }
      </div>
    }
    @if (pending(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pid]="ctx.pid()"
        (done)="onDialogDone()" (cancel)="pending.set(null)" />
    }
  `,
  styles: `
    .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .toolbar h2 { flex: 1; font-size: 16px; margin: 0; text-align: center; min-width: 120px; }
    .nav, .modes { display: flex; gap: 4px; }
    .toolbar button { min-height: 36px; min-width: 36px; padding: 0 10px; border: 1px solid var(--border-strong);
      background: var(--surface); border-radius: 8px; font-size: 13px; cursor: pointer; }
    .modes button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }

    .grid { display: grid; grid-template-columns: repeat(7, 1fr); border-top: 1px solid var(--border);
      border-left: 1px solid var(--border); }
    .dow { padding: 4px; font-size: 12px; text-align: center; color: var(--text-muted);
      border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface-alt); }
    .sun { color: var(--danger-text); }
    .sat { color: var(--primary); }
    .cell { min-height: 96px; padding: 4px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
      background: var(--surface); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .grid.week .cell { min-height: 200px; }
    .cell.out { background: var(--surface-alt); }
    .cell.out .date { color: var(--text-subtle); }
    .cell.today { box-shadow: inset 0 0 0 2px var(--primary); }
    .cell.today .date { background: var(--primary); color: var(--on-primary); border-radius: 50%;
      width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; }
    .cell-head { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    .cell-head .count { display: none; }
    .add { margin-left: auto; width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center;
      justify-content: center; text-decoration: none; color: var(--primary); font-weight: bold; opacity: 0; }
    .cell:hover .add, .add:focus { opacity: 1; }
    .items { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .item { display: block; font-size: 11px; line-height: 1.4; padding: 1px 4px; border-radius: 4px;
      border-left: 3px solid var(--disabled); background: var(--surface-alt); color: var(--text);
      text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item[data-p='high'] { border-left-color: var(--danger); }
    .item[data-p='mid'] { border-left-color: var(--warning); }
    .item[data-p='low'] { border-left-color: var(--success); }
    .item.overdue { background: var(--danger-bg); color: var(--danger-text); }
    .item.resolved { color: var(--text-muted); }
    .item .num { color: var(--text-subtle); }
        /* 長押しでブラウザのリンクのプレビューが出ないようにし、アプリのドラッグを優先する */
    .item { cursor: pointer; -webkit-touch-callout: none; user-select: none; }
    .cell.drop-future { background: var(--primary-bg); }
    .cell.drop-past { background: var(--warning-bg); }
    .cdk-drag-preview { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25); max-width: 240px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .more { border: none; background: none; color: var(--primary); font-size: 11px; text-align: left; padding: 0 4px; cursor: pointer; }

    /* スマホ：月はマスに件数だけ出し、押すとその週を開く。週は縦に1日ずつ並べる */
    @media (max-width: 600px) {
      .cell { min-height: 52px; }
      .grid:not(.week) .items { display: none; }
      .grid:not(.week) .cell-head .count { display: inline-flex; margin-left: auto; font-size: 11px; padding: 0 6px;
        border-radius: 10px; background: var(--primary-bg); color: var(--primary); }
      .grid:not(.week) .add { display: none; }
      .grid.week { grid-template-columns: 1fr; }
      .grid.week .dow { display: none; }
      .grid.week .cell { min-height: 0; }
      .add { opacity: 1; }
      .item { font-size: 13px; white-space: normal; }
    }
  `,
})
export class ProjectCalendar implements OnInit {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;

  dragging = signal<Issue | null>(null);
  /** 落としたあと、モーダルで確かめ中の変更 */
  pending = signal<{ issue: Issue; date: string } | null>(null);
  /** ドラッグを離した直後のクリックで、詳細が開かないようにする目印 */
  private justDragged = false;

  issues = signal<Issue[]>([]);
  loading = signal(true);
  mode = signal<Mode>('month');
  /** 表示の基準の日付（'YYYY-MM-DD'）。月なら、その月を出す */
  cursor = signal('');

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  todayKey = computed(() => dateKey(new Date(this.clock.now()), this.tz()));

  /** 表に並べる日付。日曜はじまり */
  days = computed<Day[]>(() => {
    const base = toUTC(this.cursor() || this.todayKey());
    if (this.mode() === 'week') {
      const start = addDays(base, -base.getUTCDay());
      return Array.from({ length: 7 }, (_, i) => this.makeDay(addDays(start, i), true));
    }
    const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    const start = addDays(first, -first.getUTCDay());
    const weeks = Math.ceil((first.getUTCDay() + last.getUTCDate()) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = addDays(start, i);
      return this.makeDay(d, d.getUTCMonth() === base.getUTCMonth());
    });
  });

  /** 日付ごとの課題。見ている人のタイムゾーンで、期限の日付に振り分ける */
  byDay = computed(() => {
    const now = this.clock.now();
    const map = new Map<string, Issue[]>();
    for (const i of this.issues()) {
      const key = dateKey(i.dueAt.toDate(), this.tz());
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    }
    for (const list of map.values()) list.sort((a, b) => compareIssues(a, b, now));
    return map;
  });

  weekdays = computed(() => {
    const fmt = new Intl.DateTimeFormat(this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US', { weekday: 'short', timeZone: 'UTC' });
    // 2026-10-04 は日曜日。そこから7日分の曜日名を作る
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 9, 4 + i))));
  });

  title = computed(() => {
    const locale = this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US';
    const days = this.days();
    if (this.mode() === 'week') {
      const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return `${fmt.format(toUTC(days[0].key))} – ${fmt.format(toUTC(days[6].key))}`;
    }
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(toUTC(this.cursor() || this.todayKey()));
  });

  async ngOnInit() {
    // URLから表示を復元する（戻るボタンや共有で、同じ月・週が開くように）
    const p = this.route.snapshot.queryParamMap;
    this.mode.set(p.get('view') === 'week' ? 'week' : 'month');
    const d = p.get('date');
    this.cursor.set(d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : this.todayKey());
    try {
      this.issues.set(await this.issueService.listOpen(this.ctx.pid()));
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  move(dir: 1 | -1) {
    const base = toUTC(this.cursor());
    const next = this.mode() === 'week'
      ? addDays(base, 7 * dir)
      : new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + dir, 1));
    this.cursor.set(keyOf(next));
    this.updateUrl();
  }

  goToday() {
    this.cursor.set(this.todayKey());
    this.updateUrl();
  }

  setMode(m: Mode) {
    this.mode.set(m);
    this.updateUrl();
  }

  /** 月の「+n」や、スマホでマスを押したときに、その週を開く */
  openWeek(key: string) {
    this.cursor.set(key);
    this.mode.set('week');
    this.updateUrl();
  }

  onCellTap(key: string) {
    if (this.mode() === 'month' && window.matchMedia('(max-width: 600px)').matches) this.openWeek(key);
  }

  private updateUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: { view: this.mode() === 'week' ? 'week' : null, date: this.cursor() },
    });
  }

  private makeDay(d: Date, inRange: boolean): Day {
    return { key: keyOf(d), d: d.getUTCDate(), dow: d.getUTCDay(), inRange };
  }

  prio(i: Issue): Level {
    return priorityOf(i);
  }
  isOverdue(i: Issue) {
    return i.status !== 'resolved' && i.dueAt.toMillis() < this.clock.now();
  }
    // ---- ドラッグで期限を変える ----
  /** つかめるのは、管理者・提起者・担当者で、クローズ前の課題だけ（ルールの editAllowed と同じ） */
  canMove(i: Issue) {
    if (i.status === 'closed') return false;
    const role = this.ctx.role();
    if (role === 'admin') return true;
    return role === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid);
  }

  onDrop(e: CdkDragDrop<string, string, Issue>) {
    this.dragging.set(null);
    if (e.previousContainer === e.container) return;
    // 並びは変えない。モーダルで保存できたら読み直す。やめたら元の日のまま
    this.pending.set({ issue: e.item.data, date: e.container.data });
  }

  onDragEnded() {
    this.dragging.set(null);
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false), 0);
  }

  open(i: Issue) {
    if (this.justDragged) return;
    this.router.navigate(['/p', this.ctx.pid(), 'i', i.id]);
  }

  async onDialogDone() {
    this.pending.set(null);
    this.issues.set(await this.issueService.listOpen(this.ctx.pid()));
  }
}