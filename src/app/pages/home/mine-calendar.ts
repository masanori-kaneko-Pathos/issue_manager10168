import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { Issue, Level } from '../../core/models';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { dateKey, shortDue } from '../../core/time/time';
import { PriorityMark } from '../../shared/priority-mark';
import { I18nService, TPipe } from '../../i18n/i18n';

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

/** ホームの「自分の課題」のカレンダー（月・見るだけ）。押した日の課題を、表の下に並べる */
@Component({
  selector: 'app-mine-calendar',
  imports: [RouterLink, TPipe, PriorityMark],
  template: `
    <div class="cal-head">
      <button type="button" class="arrow" [attr.aria-label]="'calendar.prev' | t" (click)="move(-1)">‹</button>
      <strong class="title">{{ title() }}</strong>
      <button type="button" class="arrow" [attr.aria-label]="'calendar.next' | t" (click)="move(1)">›</button>
      <button type="button" class="today-btn" [disabled]="showingToday()" (click)="goToday()">{{ 'calendar.today' | t }}</button>
    </div>
    <div class="grid">
      @for (w of weekdays(); track $index) {
        <div class="dow" [class.sun]="$index === 0" [class.sat]="$index === 6">{{ w }}</div>
      }
      @for (day of days(); track day.key) {
        @let items = byDay().get(day.key) ?? [];
        <div class="cell" [class.out]="!day.inRange" [class.today]="day.key === todayKey()"
          [class.sel]="day.key === selected()" (click)="selected.set(day.key)">
          <div class="cell-head">
            <span class="date">{{ day.d }}</span>
            @if (items.length) { <span class="count">{{ items.length }}</span> }
          </div>
          <div class="items">
            @for (i of items.slice(0, 3); track i.id) {
              <a class="item" [routerLink]="['/p', i.projectId, 'i', i.id]" [attr.data-p]="active(i) ? prio(i) : null"
                [class.overdue]="overdue(i)" [title]="i.title" (click)="$event.stopPropagation()">
                <span class="num">#{{ i.number }}</span> {{ i.title }}</a>
            }
            @if (items.length > 3) { <span class="more">+{{ items.length - 3 }}</span> }
          </div>
        </div>
      }
    </div>

    @if (selected(); as k) {
      @let list = byDay().get(k) ?? [];
      <h3 class="day-head">{{ dayLabel(k) }}<span class="n">{{ list.length }}</span></h3>
      <ul class="ilist">
        @for (i of list; track i.id) {
          <li>
            @if (active(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> } @else { <span class="prio-none"></span> }
            <a class="ititle" [routerLink]="['/p', i.projectId, 'i', i.id]"><span class="num">#{{ i.number }}</span> {{ i.title }}</a>
            <span class="iproj">{{ nameOf()(i.projectId) }}</span>
            <span class="idue" [class.overdue]="overdue(i)">{{ dueLabel(i) }}</span>
          </li>
        } @empty {
          <li class="none">{{ 'calendar.noneOnDay' | t }}</li>
        }
      </ul>
    }
  `,
  styles: `
    .cal-head { display: flex; align-items: center; gap: 4px; margin: 8px 0; }
    .title { min-width: 9em; text-align: center; font-size: 15px; }
    .arrow { width: 32px; height: 32px; border: none; border-radius: 50%; background: none; color: var(--text);
      font-size: 20px; line-height: 1; cursor: pointer; }
    .arrow:hover { background: var(--surface-alt); }
    .today-btn { margin-left: 8px; min-height: 32px; padding: 0 10px; border: 1px solid var(--border-strong);
      border-radius: 8px; background: var(--surface); font-size: 13px; cursor: pointer; }
    .today-btn:disabled { color: var(--text-disabled); border-color: var(--border); cursor: default; }
    .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-top: 1px solid var(--border);
      border-left: 1px solid var(--border); }
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
    .cell-head { display: flex; align-items: center; gap: 4px; font-size: 12px; }
    .cell.today .date { width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%; background: var(--primary); color: var(--on-primary); }
    .count { display: none; margin-left: auto; font-size: 11px; padding: 0 6px; border-radius: 10px;
      background: var(--primary-bg); color: var(--primary); }
    .items { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .item { display: block; font-size: 11px; line-height: 1.4; padding: 1px 4px; border-radius: 4px;
      border-left: 3px solid var(--disabled); background: var(--surface-alt); color: var(--text); text-decoration: none;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item[data-p='high'] { border-left-color: var(--danger); }
    .item[data-p='mid'] { border-left-color: var(--warning); }
    .item[data-p='low'] { border-left-color: var(--success); }
    .item.overdue { background: var(--danger-bg); color: var(--danger-text); }
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
    /* スマホ：マスには件数だけ。押すと、下の一覧で見る */
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

  private clock = inject(Clock);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  private locale = computed(() => (this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US'));

  todayKey = computed(() => dateKey(new Date(this.clock.now()), this.tz()));
  /** 表示している月（その月のどこかの日） */
  cursor = signal('');
  /** 押した日（最初は今日） */
  selected = signal<string | null>(null);

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
    for (const i of this.issues()) {
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
    this.cursor.set(keyOf(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + dir, 1))));
  }

  goToday() {
    this.cursor.set(this.todayKey());
    this.selected.set(this.todayKey());
  }

  dayLabel(k: string) {
    return new Intl.DateTimeFormat(this.locale(), { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'UTC' })
      .format(toUTC(k));
  }

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