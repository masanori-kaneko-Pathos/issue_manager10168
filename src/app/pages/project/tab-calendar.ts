import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { auth } from '../../core/firebase';
import { DueDialog } from '../../shared/due-dialog';
import { PriorityMark } from '../../shared/priority-mark';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { IssueService } from '../../core/issue/issue.service';
import { Issue, Level } from '../../core/models';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { ProjectContext } from './project-context';
import { dateKey } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { PeopleFilter, whoFromQuery, whoQuery } from '../../shared/people-filter';
import { TrashDrop } from '../../shared/trash-drop';
import { DeleteDialog } from '../issue/delete-dialog';
import { UndoService } from '../../core/undo/undo.service';
import { IssueFormService } from '../../core/issue/issue-form.service';
import { MonthPicker } from '../../shared/month-picker';
import { RecurMark } from '../../shared/recur-mark';

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
  selector: 'app-tab-calendar',
  imports: [RouterLink, TPipe, CdkDropListGroup, CdkDropList, CdkDrag, DueDialog, PriorityMark, PeopleFilter,
    TrashDrop, DeleteDialog, MonthPicker, RecurMark],
  template: `
    <div class="toolbar">
      <app-people-filter [members]="ctx.assignable()" [counts]="ctx.activeCount()" [value]="who()"
        (picked)="setWho($event)" />
      <div class="center">
        <button type="button" class="arrow" (click)="move(-1)" [attr.aria-label]="'calendar.prev' | t">‹</button>
        <app-month-picker [value]="cursor()" [label]="title()" [today]="todayKey()" (picked)="pickMonth($event)" />
        <button type="button" class="arrow" (click)="move(1)" [attr.aria-label]="'calendar.next' | t">›</button>
        <button type="button" class="today-btn" [disabled]="showingToday()" (click)="goToday()">
          {{ 'calendar.today' | t }}</button>
      </div>
      <div class="modes">
        <button type="button" [class.on]="mode() === 'month'" (click)="setMode('month')">{{ 'calendar.month' | t }}</button>
        <button type="button" [class.on]="mode() === 'week'" (click)="setMode('week')">{{ 'calendar.week' | t }}</button>
      </div>
    </div>

    @if (loading()) {
      <p>{{ 'common.loading' | t }}</p>
    } @else {
      <!-- 月・週を移るたびに表を作り直し、新しい表のマスをすべり込ませる（名札が変わると、@for が作り直す） -->
      @for (k of [gridKey()]; track k) {
      <div class="grid" [class.week]="mode() === 'week'" [attr.data-slide]="slideDir()" cdkDropListGroup>
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
                <button type="button" class="add" [attr.aria-label]="'calendar.addOn' | t: { date: day.key }"
                  (click)="$event.stopPropagation(); issueForm.open(ctx.pid(), { due: day.key })">＋</button>
              }
            </div>
            <div class="items">
              @for (i of (mode() === 'week' ? items : items.slice(0, 3)); track i.id) {
                <div class="item" role="link" tabindex="0" [attr.data-p]="isActive(i) ? prio(i) : null" [class.overdue]="isOverdue(i)"
                  [class.resolved]="i.status === 'resolved'" [title]="i.title"
                  cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canMove(i)" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                  (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnded()"
                  (click)="open(i); $event.stopPropagation()" (keydown.enter)="open(i)">
                  @if (isOverdue(i)) {
                    <span class="bang" role="img" [attr.aria-label]="'due.overdue' | t" [title]="'due.overdue' | t">!</span>
                  }
                  @if (isActive(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> }
                  <span class="num">#{{ i.number }}</span> @if (i.recurringId) { <app-recur-mark [size]="11" /> } {{ i.title }}
                </div>
              }
              @if (mode() === 'month' && items.length > 3) {
                <button type="button" class="more" (click)="openWeek(day.key); $event.stopPropagation()">
                  +{{ items.length - 3 }}</button>
              }
            </div>
          </div>
        }
        @if (canTrash()) { <app-trash-drop [show]="!!dragging()" (dropped)="deleting.set($event)" /> }
      </div>
      }
    }
    @if (pending(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pid]="ctx.pid()" [members]="ctx.members()"
        (done)="onDialogDone()" (cancel)="pending.set(null)" />
    }
    @if (deleting(); as d) {
      <app-delete-dialog [pid]="ctx.pid()" [issue]="d" [members]="ctx.members()"
        (done)="onDeleted(d)" (cancel)="deleting.set(null)" />
    }

  `,
  styles: `
    /* 左（人）・真ん中（‹ 年月 › 今日）・右（月｜週）。左右が同じ幅を取り合うので、真ん中はいつも真ん中 */
    .toolbar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; margin-bottom: 12px; }
    .toolbar app-people-filter { justify-self: start; }
    .center { display: flex; align-items: center; gap: 2px; }
    .modes { justify-self: end; display: flex; gap: 4px; }
    .modes button, .today-btn { min-height: 36px; min-width: 36px; padding: 0 10px; border: 1px solid var(--border-strong);
      background: var(--surface); border-radius: 8px; font-size: 13px; cursor: pointer; }
    .modes button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .today-btn { margin-left: 8px; }
    .today-btn:disabled { color: var(--text-disabled); border-color: var(--border); cursor: default; }
    .arrow { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--text);
      font-size: 20px; line-height: 1; cursor: pointer; }
    .arrow:hover { background: var(--surface-alt); }

    .grid { display: grid; grid-template-columns: repeat(7, 1fr); border-top: 1px solid var(--border);
      border-left: 1px solid var(--border); }
    /* 月・週を移ったとき：先へは右から、前へは左から、マスがすべり込む。表示の切り替えは、ふわっと */
    .grid { overflow: hidden; }
    @keyframes cal-next { from { opacity: 0; translate: 32px 0; } }
    @keyframes cal-prev { from { opacity: 0; translate: -32px 0; } }
    @keyframes cal-fade { from { opacity: 0; } }
    .grid[data-slide='1'] .cell { animation: cal-next 200ms var(--ease-out); }
    .grid[data-slide='-1'] .cell { animation: cal-prev 200ms var(--ease-out); }
    .grid[data-slide='0'] .cell { animation: cal-fade 160ms var(--ease-out); }
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
    .add { margin-left: auto; width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%; background: none;
      display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
      color: var(--primary); font-size: inherit; font-weight: bold; opacity: 0; cursor: pointer; }
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
    .item .bang { font-weight: bold; color: var(--danger-text); margin-right: 3px; }
    .item app-priority-mark { vertical-align: middle; margin-right: 3px; }
        /* 長押しでブラウザのリンクのプレビューが出ないようにし、アプリのドラッグを優先する */
    .item { cursor: pointer; -webkit-touch-callout: none; user-select: none; }
    .cell.drop-future { background: var(--primary-bg); }
    .cell.drop-past { background: var(--warning-bg); }
    .cdk-drag-preview { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25); max-width: 240px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .more { border: none; background: none; color: var(--primary); font-size: 11px; text-align: left; padding: 0 4px; cursor: pointer; }

    /* スマホ：月はマスに件数だけ出し、押すとその週を開く。週は縦に1日ずつ並べる */
    @media (max-width: 600px) {
      /* スマホ：1段目に人と月｜週、2段目の真ん中に ‹ 年月 › 今日 */
      .toolbar { grid-template-columns: 1fr auto; }
      .center { grid-column: 1 / -1; grid-row: 2; justify-content: center; }
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
  private undo = inject(UndoService);
  protected issueForm = inject(IssueFormService);
  /** ゴミ箱に落とした課題（削除の窓で確かめ中） */
  deleting = signal<Issue | null>(null);
  /** ゴミ箱を出すか：削除できるのは管理者だけ。アーカイブ中は出さない */
  canTrash = computed(() => this.ctx.role() === 'admin' && !this.ctx.archived());
  /** ドラッグを離した直後のクリックで、詳細が開かないようにする目印 */
  private justDragged = false;

  /** つかんでいる間は、つかんだ時点のままにする */
  private frozen = signal<Issue[] | null>(null);
  issues = computed(() => this.frozen() ?? this.ctx.openIssues());
  /** URL から読んだ「選んだ人」（抜けた人が混ざっていることもある） */
  private whoRaw = signal<string[]>([]);
  /** 絞り込みに使う人。担当者になれる人だけ残す（抜けた人は黙って外す） */
  who = computed(() => {
    const ok = new Set(this.ctx.assignable().map((m) => m.uid));
    return this.whoRaw().filter((u) => ok.has(u));
  });
  /** 人の絞り込みをかけた課題 */
  shown = computed(() => {
    const who = new Set(this.who());
    return who.size ? this.issues().filter((i) => who.has(i.assigneeId)) : this.issues();
  });
  loading = computed(() => this.ctx.issuesLoading());
  mode = signal<Mode>('month');
  /** 表示の基準の日付（'YYYY-MM-DD'）。月なら、その月を出す */
  cursor = signal('');
  /** すべり込む向き（1＝先へ、-1＝前へ、0＝ふわっと、null＝開いた直後は動かさない） */
  slideDir = signal<1 | -1 | 0 | null>(null);
  /** 表の名札：表示（月・週）と最初の日。これが変わると、表を作り直す */
  gridKey = computed(() => this.mode() + ':' + (this.days()[0]?.key ?? ''));

  /** 表示する日を変える。今より先なら右から、前なら左から（日付は 'YYYY-MM-DD' なので、文字のままで比べられる） */
  private go(next: string) {
    const cur = this.cursor();
    this.slideDir.set(next > cur ? 1 : next < cur ? -1 : 0);
    this.cursor.set(next);
  }


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
    for (const i of this.shown()) {
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

  // ---- 年月の選び窓（部品は MonthPicker） ----

  /** 今日が、今の表示の中に見えているか（見えているときは「今日」を押せなくする） */
  showingToday = computed(() => this.days().some((d) => d.key === this.todayKey() && d.inRange));

  /** 選び窓で月を選んだ：その月の1日へ（週の表示なら、1日を含む週へ） */
  pickMonth(key: string) {
    this.go(key);
    this.updateUrl();
  }

  async ngOnInit() {
    // URLから表示を復元する（戻るボタンや共有で、同じ月・週が開くように）
    const p = this.route.snapshot.queryParamMap;
    this.mode.set(p.get('view') === 'week' ? 'week' : 'month');
    const d = p.get('date');
    this.cursor.set(d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : this.todayKey());
    this.whoRaw.set(whoFromQuery(p, this.myUid));
  }

  move(dir: 1 | -1) {
    const base = toUTC(this.cursor());
    const next = this.mode() === 'week'
      ? addDays(base, 7 * dir)
      : new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + dir, 1));
      this.go(keyOf(next));
    this.updateUrl();
  }

  goToday() {
    this.go(this.todayKey());
    this.updateUrl();
  }

  setWho(list: string[]) {
    this.whoRaw.set(list);
    this.updateUrl();
  }

  setMode(m: Mode) {
    this.slideDir.set(0);
    this.mode.set(m);
    this.updateUrl();
  }

  /** 月の「+n」や、スマホでマスを押したときに、その週を開く */
  openWeek(key: string) {
    this.slideDir.set(0);
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
      queryParams: { ...whoQuery(this.who()), view: this.mode() === 'week' ? 'week' : null, date: this.cursor() },
    });
  }

  private makeDay(d: Date, inRange: boolean): Day {
    return { key: keyOf(d), d: d.getUTCDate(), dow: d.getUTCDay(), inRange };
  }

  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  isOverdue(i: Issue) {
    return i.status !== 'resolved' && i.dueAt.toMillis() < this.clock.now();
  }
  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  // ---- ドラッグで期限を変える ----
  /** つかめるのは、管理者・提起者・担当者で、クローズ前の課題だけ（ルールの editAllowed と同じ） */
  canMove(i: Issue) {
    if (i.status === 'closed' || this.ctx.archived()) return false;
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

  onDragStart(i: Issue) {
    this.frozen.set(this.issues());
    this.dragging.set(i);
  }

  onDragEnded() {
    this.dragging.set(null);
    this.frozen.set(null);
    // 離した直後のクリックだけ止める。クリックが届いたあとで目印を戻す
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false));
  }

  open(i: Issue) {
    if (this.justDragged) return;
    this.router.navigate(['/p', this.ctx.pid(), 'i', i.id]);
  }

  onDialogDone() {
    this.pending.set(null);
  }

   /** 削除できた：「元に戻す」を出す */
   onDeleted(i: Issue) {
    this.deleting.set(null);
    this.undo.offer('delete.moved', { n: String(i.number) },
      () => this.issueService.restoreIssue(this.ctx.pid(), i.id, this.myUid, this.tz()));
  } 
}