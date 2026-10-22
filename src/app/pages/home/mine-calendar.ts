import { Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { ProjectService } from '../../core/project/project.service';
import { Issue, Level, Member, ProjectWithRole } from '../../core/models';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { dateKey, shortDue } from '../../core/time/time';
import { PriorityMark } from '../../shared/priority-mark';
import { DueDialog } from '../../shared/due-dialog';
import { I18nService, TPipe } from '../../i18n/i18n';
import { MonthPicker } from '../../shared/month-picker';
import { RecurMark } from '../../shared/recur-mark';

type Mine = Issue & { projectId: string };
interface Day { key: string; d: number; dow: number; inRange: boolean; }

/** 日付の計算は「日付だけ」の UTC で行う（プロジェクトのカレンダーと同じ） */
function toUTC(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function keyOf(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
function addDays(dt: Date, n: number): Date {
  const x = new Date(dt);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/**
 * ホームの「自分の課題」のカレンダー（月）。押した日の課題を、表の下に並べる。
 * 課題を別の日に落とすと、期限の窓（理由つき・元に戻すつき）が開く。
 * 動かしてよいかは、カードごとに「そのプロジェクトでの自分の役割」で決める（プロジェクトのカレンダーと同じ決まり）
 */
@Component({
  selector: 'app-mine-calendar',
  imports: [RouterLink, TPipe, PriorityMark, MonthPicker, RecurMark, CdkDropListGroup, CdkDropList, CdkDrag, DueDialog],
  template: `
    <div class="cal-head">
      <button type="button" class="arrow" [attr.aria-label]="'calendar.prev' | t" (click)="move(-1)">‹</button>
      <app-month-picker [value]="cursor()" [label]="title()" [today]="todayKey()" (picked)="go($event)" />
      <button type="button" class="arrow" [attr.aria-label]="'calendar.next' | t" (click)="move(1)">›</button>
      <button type="button" class="today-btn" [disabled]="showingToday()" (click)="goToday()">{{ 'calendar.today' | t }}</button>
    </div>
    <!-- 月を移るたびに表を作り直し、新しい表のマスをすべり込ませる -->
    @for (g of [gridKey()]; track g) {
    <div class="grid" [attr.data-slide]="slideDir()" cdkDropListGroup>
      @for (w of weekdays(); track $index) {
        <div class="dow" [class.sun]="$index === 0" [class.sat]="$index === 6">{{ w }}</div>
      }
      @for (day of days(); track day.key) {
        @let items = byDay().get(day.key) ?? [];
        <div class="cell" [class.out]="!day.inRange" [class.today]="day.key === todayKey()"
          [class.sel]="day.key === selected()" (click)="selected.set(day.key)"
          cdkDropList [cdkDropListData]="day.key" [cdkDropListSortingDisabled]="true"
          (cdkDropListDropped)="onDrop($event)"
          [class.drop-future]="!!dragging() && day.key >= todayKey()"
          [class.drop-past]="!!dragging() && day.key < todayKey()">
          <div class="cell-head">
            <span class="date">{{ day.d }}</span>
            @if (items.length) { <span class="count">{{ items.length }}</span> }
          </div>
          <div class="items">
            @for (i of items.slice(0, 3); track i.id) {
              <!-- リンクにしない：離した瞬間のクリックで詳細へ飛ばないよう、open() で目印を見てから移る -->
              <div class="item" role="link" tabindex="0" [attr.data-p]="active(i) ? prio(i) : null"
                [class.overdue]="overdue(i)" [class.movable]="canMove(i)" [title]="i.title"
                cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canMove(i)" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnd()"
                (click)="open(i); $event.stopPropagation()" (keydown.enter)="open(i)">
                <span class="num">#{{ i.number }}</span> @if (i.recurringId) { <app-recur-mark [size]="11" /> } {{ i.title }}</div>
            }
            @if (items.length > 3) { <span class="more">+{{ items.length - 3 }}</span> }
          </div>
        </div>
      }
    </div>
    }

    @if (selected(); as k) {
      @let list = byDay().get(k) ?? [];
      <h3 class="day-head">{{ dayLabel(k) }}<span class="n">{{ list.length }}</span></h3>
      <ul class="ilist">
        @for (i of list; track i.id) {
          <li>
            @if (active(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> } @else { <span class="prio-none"></span> }
            <a class="ititle" [routerLink]="['/p', i.projectId, 'i', i.id]"><span class="num">#{{ i.number }}</span> @if (i.recurringId) { <app-recur-mark [size]="11" /> } {{ i.title }}</a>
            <span class="iproj">{{ nameOf()(i.projectId) }}</span>
            <span class="idue" [class.overdue]="overdue(i)">{{ dueLabel(i) }}</span>
          </li>
        } @empty {
          <li class="none">{{ 'calendar.noneOnDay' | t }}</li>
        }
      </ul>
    }

    @if (pending(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pid]="p.issue.projectId" [members]="p.members"
        (done)="pending.set(null)" (cancel)="pending.set(null)" />
    }
  `,
  styles: `
    /* プロジェクトのカレンダーと同じ：‹ 年月 ▾ › 今日 を真ん中に */
    .cal-head { display: flex; align-items: center; justify-content: center; gap: 2px; margin: 8px 0; }
    .arrow { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--text);
      font-size: 20px; line-height: 1; cursor: pointer; }
    .arrow:hover { background: var(--surface-alt); }
    .today-btn { margin-left: 8px; min-height: 32px; padding: 0 10px; border: 1px solid var(--border-strong);
      border-radius: 8px; background: var(--surface); font-size: 13px; cursor: pointer; }
    .today-btn:disabled { color: var(--text-disabled); border-color: var(--border); cursor: default; }
    .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-top: 1px solid var(--border);
      border-left: 1px solid var(--border); }
    /* 月を移ったとき：先へは右から、前へは左から、マスがすべり込む */
    .grid { overflow: hidden; }
    @keyframes cal-next { from { opacity: 0; translate: 32px 0; } }
    @keyframes cal-prev { from { opacity: 0; translate: -32px 0; } }
    @keyframes cal-fade { from { opacity: 0; } }
    .grid[data-slide='1'] .cell { animation: cal-next 200ms var(--ease-out); }
    .grid[data-slide='-1'] .cell { animation: cal-prev 200ms var(--ease-out); }
    .grid[data-slide='0'] .cell { animation: cal-fade 160ms var(--ease-out); }
    .dow { padding: 4px; font-size: 12px; text-align: center; color: var(--text-muted); background: var(--surface-alt);
      border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
    .sun { color: var(--danger-text); }
    .sat { color: var(--primary); }
    .cell { min-height: 84px; padding: 4px; display: flex; flex-direction: column; gap: 2px; min-width: 0;
      border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface); cursor: pointer; }
    .cell:hover { background: var(--surface-alt); }
    .cell.out { background: var(--surface-alt); }
    .cell.out .date { color: var(--text-subtle); }
    .cell.sel { box-shadow: inset 0 0 0 2px var(--primary); }
    /* つかんでいる間：今日から先は青、過去は黄（過去に落とすと、窓で「期限切れとして確定」になる） */
    .cell.drop-future { background: var(--primary-bg); }
    .cell.drop-past { background: var(--warning-bg); }
    .cell-head { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    .cell.today .date { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%; background: var(--primary); color: var(--on-primary); }
    .count { display: none; margin-left: auto; font-size: 11px; padding: 0 6px; border-radius: 10px;
      background: var(--primary-bg); color: var(--primary); }
    .items { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .item { display: block; font-size: 11px; line-height: 1.4; padding: 1px 4px; border-radius: 4px;
      border-left: 3px solid var(--disabled); background: var(--surface-alt); color: var(--text); cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      -webkit-touch-callout: none; user-select: none; }
    .item.movable { cursor: grab; }
    .item:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
    .item[data-p='high'] { border-left-color: var(--danger); }
    .item[data-p='mid'] { border-left-color: var(--warning); }
    .item[data-p='low'] { border-left-color: var(--success); }
    .item.overdue { background: var(--danger-bg); color: var(--danger-text); }
    .cdk-drag-preview { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25); max-width: 240px; }
    .cdk-drag-placeholder { opacity: 0.3; }
    .num { color: var(--text-subtle); }
    .more { font-size: 11px; color: var(--primary); padding: 0 4px; }
    .day-head { display: flex; align-items: center; gap: 6px; margin: 16px 0 4px; font-size: 13px; color: var(--text-muted); }
    .n { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface-alt); }
    .ilist { list-style: none; margin: 0; padding: 0; }
    .ilist li { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 2px 8px;
      border-bottom: 1px solid var(--border); }
    .ilist app-priority-mark, .prio-none { width: 18px; flex: none; }
    .ititle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text); text-decoration: none; font-size: 14px; }
    .ititle:hover { text-decoration: underline; }
    .iproj { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; color: var(--text-muted); }
    .idue { flex: none; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .idue.overdue { color: var(--danger-text); font-weight: bold; }
    .none { color: var(--text-muted); font-size: 13px; }
    /* スマホ：マスには件数だけ。押すと、下の一覧で見る（マスの中の課題は出さないので、ドラッグは PC だけ） */
    @media (max-width: 600px) {
      .cell { min-height: 48px; }
      .items { display: none; }
      .count { display: inline-flex; }
      .iproj { display: none; }
    }
  `,
})
export class MineCalendar {
  issues = input.required<Mine[]>();
  nameOf = input.required<(pid: string) => string>();
  /** 所属するプロジェクト（役割を見るため。ホームの一覧をそのまま受け取る） */
  projects = input<ProjectWithRole[]>([]);

  private clock = inject(Clock);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private ps = inject(ProjectService);
  private router = inject(Router);
  private readonly myUid = auth.currentUser!.uid;
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  private locale = computed(() => (this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US'));

  todayKey = computed(() => dateKey(new Date(this.clock.now()), this.tz()));
  /** 表示している月（その月のどこかの日） */
  cursor = signal('');
  /** 押した日（最初は今日） */
  selected = signal<string | null>(null);
  /** すべり込む向き（1＝先へ、-1＝前へ、0＝ふわっと、null＝開いた直後は動かさない） */
  slideDir = signal<1 | -1 | 0 | null>(null);
  /** 表の名札：最初の日。これが変わると、表を作り直す */
  gridKey = computed(() => this.days()[0]?.key ?? '');

  /** つかんでいる課題 */
  dragging = signal<Mine | null>(null);
  /** つかんでいる間は、つかんだ時点のままにする（届いた変更は、離したあとに反映） */
  private frozen = signal<Mine[] | null>(null);
  private shown = computed(() => this.frozen() ?? this.issues());
  /** 落としたあと、期限の窓で確かめ中の変更（members は、そのプロジェクトのメンバー） */
  pending = signal<{ issue: Mine; date: string; members: Member[] } | null>(null);
  /** 離した直後のクリックで、詳細が開かないようにする目印 */
  private justDragged = false;

  /** 表示する月を変える。今より先なら右から、前なら左から（選び窓からも呼ぶ） */
  go(next: string) {
    const cur = this.cursor();
    this.slideDir.set(next > cur ? 1 : next < cur ? -1 : 0);
    this.cursor.set(next);
  }

  constructor() {
    const t = this.todayKey();
    this.cursor.set(t);
    this.selected.set(t);
  }

  /** 日曜はじまりの月の表 */
  days = computed<Day[]>(() => {
    const base = toUTC(this.cursor());
    const first = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
    const start = addDays(first, -first.getUTCDay());
    const weeks = Math.ceil((first.getUTCDay() + last.getUTCDate()) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = addDays(start, i);
      return { key: keyOf(d), d: d.getUTCDate(), dow: d.getUTCDay(), inRange: d.getUTCMonth() === base.getUTCMonth() };
    });
  });

  /** 期限の日（見ている人のタイムゾーン）ごとの課題 */
  byDay = computed(() => {
    const now = this.clock.now();
    const map = new Map<string, Mine[]>();
    for (const i of this.shown()) {
      const k = dateKey(i.dueAt.toDate(), this.tz());
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(i);
    }
    for (const list of map.values()) list.sort((a, b) => compareIssues(a, b, now));
    return map;
  });

  weekdays = computed(() => {
    const fmt = new Intl.DateTimeFormat(this.locale(), { weekday: 'short', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2026, 9, 4 + i)))); // 2026-10-04 は日曜
  });

  title = computed(() => new Intl.DateTimeFormat(this.locale(), { year: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(toUTC(this.cursor())));

  showingToday = computed(() => this.days().some((d) => d.key === this.todayKey() && d.inRange));

  move(dir: 1 | -1) {
    const b = toUTC(this.cursor());
    this.go(keyOf(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + dir, 1))));
  }

  goToday() {
    this.go(this.todayKey());
    this.selected.set(this.todayKey());
  }

  dayLabel(k: string) {
    return new Intl.DateTimeFormat(this.locale(), { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' })
      .format(toUTC(k));
  }

  // ---- ドラッグで期限を変える ----

  private projectOf(pid: string) {
    return this.projects().find((p) => p.id === pid) ?? null;
  }

  /**
   * つかめるのは、そのプロジェクトの管理者か、メンバーで提起者・担当者のとき。クローズ前の課題だけ。
   * アーカイブ中のプロジェクトは動かせない（ルールの editAllowed・プロジェクトのカレンダーと同じ決まり）
   */
  canMove(i: Mine) {
    const p = this.projectOf(i.projectId);
    if (!p || p.archived || i.status === 'closed') return false;
    return p.role === 'admin'
      || (p.role === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid));
  }

  onDragStart(i: Mine) {
    this.frozen.set(this.issues());
    this.dragging.set(i);
  }

  onDragEnd() {
    this.dragging.set(null);
    this.frozen.set(null);
    // 離した直後のクリックだけ止める。クリックが届いたあとで目印を戻す
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false));
  }

  /** 別の日に落としたら、期限の窓を開く（窓は「だれが先に更新したか」の名前にメンバーを使うので、そのとき1回だけ読む） */
  async onDrop(e: CdkDragDrop<string, string, Mine>) {
    this.dragging.set(null);
    // 指がマスの上にないところで離したら、何もしない（CDK は「最後に入ったマス」に落としたことにしてしまうため）
    if (e.previousContainer === e.container || !e.isPointerOverContainer) return;
    const issue = e.item.data;
    const members = await this.ps.listMembers(issue.projectId).catch(() => [] as Member[]);
    this.pending.set({ issue, date: e.container.data, members });
  }

  open(i: Mine) {
    if (this.justDragged) return;
    this.router.navigate(['/p', i.projectId, 'i', i.id]);
  }

  // ---- 表示用 ----

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