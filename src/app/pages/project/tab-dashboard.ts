import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { IssueService } from '../../core/issue/issue.service';
import { Clock } from '../../core/time/clock';
import { DEFAULT_SETTINGS, Issue, Level, OPEN_STATUSES } from '../../core/models';
import {
  Period, avgResolveDays, byCause, matrix, memberRows, nowStats, periodRange, resolvedIn,
} from '../../core/dashboard/stats';
import { ProjectContext } from './project-context';
import { HelpTip } from '../../shared/help-tip';
import { I18nService, TPipe } from '../../i18n/i18n';

/** ダッシュボード。上は「今」の状況、下は期間（今週・先週・今月）の集計 */
@Component({
  selector: 'app-tab-dashboard',
  imports: [RouterLink, TPipe, HelpTip],
  template: `
    @if (overLimit()) {
      <p class="warn" role="alert">{{ 'dashboard.overLimit' | t: { n: '' + now().high, limit: '' + settings().highPriorityLimit } }}</p>
    }

    <div class="cards">
      <div class="card"><span class="k">{{ 'dashboard.active' | t }}</span><strong>{{ now().active }}</strong></div>
      <div class="card" [class.bad]="now().overdue > 0">
        <span class="k">{{ 'dashboard.overdue' | t }}</span><strong>{{ now().overdue }}</strong></div>
      <div class="card"><span class="k">{{ 'dashboard.stale' | t }}</span><strong>{{ now().stale }}</strong></div>
      <div class="card"><span class="k">{{ 'dashboard.high' | t }}</span><strong>{{ now().high }}</strong></div>
    </div>

    <section>
      <h2>{{ 'dashboard.matrix' | t }} <app-help-tip [keys]="['dashboard.matrixHelp']" /></h2>
      <div class="matrix" role="grid">
        <span class="corner">{{ 'dashboard.importanceAxis' | t }} ＼ {{ 'dashboard.urgencyAxis' | t }}</span>
        @for (u of levels; track u) { <span class="axis">{{ 'priority.' + u | t }}</span> }
        @for (imp of levels; track imp) {
          <span class="axis">{{ 'importance.' + imp | t }}</span>
          @for (u of levels; track u) {
            @let c = cellOf(imp, u);
            <button type="button" class="cell" [attr.data-p]="c.priority" [class.on]="isPicked(imp, u)"
              [attr.aria-pressed]="isPicked(imp, u)"
              [attr.aria-label]="'dashboard.cellLabel' | t: { imp: i18n.t('importance.' + imp), urg: i18n.t('priority.' + u),
                p: i18n.t('priority.' + c.priority), n: '' + c.issues.length }"
              (click)="pick(imp, u)">
              <strong>{{ c.issues.length }}</strong>
              <span class="p">{{ 'priority.' + c.priority | t }}</span>
            </button>
          }
        }
      </div>
      @if (picked()) {
        <ul class="picked">
          @for (i of pickedIssues(); track i.id) {
            <li><a [routerLink]="['/p', ctx.pid(), 'i', i.id]"><span class="num">#{{ i.number }}</span> {{ i.title }}</a>
              <span class="who">{{ ctx.nameOf(i.assigneeId) }}</span></li>
          } @empty {
            <li class="empty">{{ 'dashboard.none' | t }}</li>
          }
        </ul>
      } @else {
        <p class="help">{{ 'dashboard.pickHint' | t }}</p>
      }
    </section>

    <section>
      <div class="period-row">
        <div class="chips" role="group">
          @for (p of periods; track p) {
            <button type="button" [class.on]="period() === p" [attr.aria-pressed]="period() === p"
              (click)="period.set(p)">{{ 'dashboard.period.' + p | t }}</button>
          }
        </div>
        <span class="range">{{ rangeLabel() }}</span>
      </div>

      @if (closedLoadError()) {
        <p class="error" role="alert">{{ 'common.loadError' | t }}</p>
      } @else if (!all()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <div class="two">
          <div class="box">
            <h3>{{ 'dashboard.avgDays' | t }} <app-help-tip [keys]="['dashboard.avgHelp']" /></h3>
            @if (avgDays() !== null) {
              <p class="big">{{ 'dashboard.days' | t: { n: '' + avgDays() } }}</p>
              <p class="help">{{ 'dashboard.basedOn' | t: { n: '' + resolved().length } }}</p>
            } @else {
              <p class="help">{{ 'dashboard.noData' | t }}</p>
            }
          </div>
          <div class="box">
            <h3>{{ 'dashboard.causes' | t }}</h3>
            @for (c of causes(); track c.cat) {
              <div class="bar-row">
                <span class="bar-name">{{ 'causeCategories.' + c.cat | t }}</span>
                <span class="bar"><span class="fill" [style.width.%]="(c.n / causeMax()) * 100"></span></span>
                <span class="bar-n">{{ c.n }}</span>
              </div>
            } @empty {
              <p class="help">{{ 'dashboard.noData' | t }}</p>
            }
          </div>
        </div>

        @if (rows().length) {
          <h3>{{ 'dashboard.members' | t }} <app-help-tip [keys]="['dashboard.membersHelp']" /></h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{{ 'dashboard.cols.name' | t }}</th>
                  <th>{{ 'dashboard.cols.assigned' | t }}</th>
                  <th>{{ 'dashboard.cols.overdue' | t }}</th>
                  <th>{{ 'dashboard.cols.resolved' | t }}</th>
                  <th>{{ 'dashboard.cols.onTime' | t }}</th>
                  <th>{{ 'dashboard.cols.effect' | t }}</th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.uid) {
                  <tr>
                    <th scope="row">{{ r.name }}</th>
                    <td>{{ r.assigned }}</td>
                    <td [class.bad]="r.overdue > 0">{{ r.overdue }}</td>
                    <td>{{ r.resolved }}</td>
                    <td>{{ r.onTime === null ? '—' : percent(r.onTime) }}</td>
                    <td>{{ r.effect.yes }} / {{ r.effect.partial }} / {{ r.effect.no }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    </section>
  `,
  styles: `
    h2 { font-size: 16px; margin: 20px 0 8px; }
    h3 { font-size: 14px; margin: 0 0 8px; }
    .warn { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .card { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 10px;
      background: var(--surface-alt); }
    .card .k { font-size: 12px; color: var(--text-muted); }
    .card strong { font-size: 24px; }
    .card.bad strong { color: var(--danger-text); }
    .matrix { display: grid; grid-template-columns: auto repeat(3, 1fr); gap: 4px; max-width: 520px; }
    .corner { font-size: 11px; color: var(--text-muted); align-self: end; }
    .axis { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-muted);
      padding: 4px; }
    .cell { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      min-height: 64px; border: 2px solid transparent; border-radius: 8px; cursor: pointer; color: var(--text); }
    .cell[data-p='high'] { background: var(--danger-bg); }
    .cell[data-p='mid'] { background: var(--warning-bg); }
    .cell[data-p='low'] { background: var(--success-bg); }
    .cell.on { border-color: var(--primary); }
    .cell strong { font-size: 20px; }
    .cell .p { font-size: 11px; color: var(--text-secondary); }
    .picked { list-style: none; margin: 8px 0 0; padding: 0; max-width: 520px; }
    .picked li { display: flex; gap: 8px; align-items: center; padding: 6px 4px; border-bottom: 1px solid var(--border); }
    .picked a { flex: 1; color: var(--text); text-decoration: none; overflow-wrap: anywhere; }
    .num { color: var(--text-muted); font-size: 13px; }
    .who { font-size: 12px; color: var(--text-muted); }
    .help { font-size: 12px; color: var(--text-muted); margin: 6px 0; }
    .period-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 24px 0 12px; }
    .chips { display: flex; gap: 6px; }
    .chips button { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 18px; font-size: 13px; cursor: pointer; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .range { font-size: 13px; color: var(--text-muted); }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .box { padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
    .big { font-size: 28px; font-weight: bold; margin: 0; }
    .bar-row { display: grid; grid-template-columns: 9em 1fr 2em; align-items: center; gap: 8px; margin: 4px 0;
      font-size: 13px; }
    .bar-name { overflow-wrap: anywhere; }
    .bar { height: 12px; border-radius: 6px; background: var(--surface-alt); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--primary); }
    .bar-n { text-align: right; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { padding: 8px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
    th:first-child { text-align: left; }
    thead th { font-size: 12px; color: var(--text-muted); font-weight: normal; }
    td.bad { color: var(--danger-text); font-weight: bold; }
    .error { color: var(--danger-text); }
    @media (max-width: 600px) {
      .cards { grid-template-columns: repeat(2, 1fr); }
      .two { grid-template-columns: 1fr; }
    }
  `,
})
export class TabDashboard implements OnInit {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  protected i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;

  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly periods: Period[] = ['thisWeek', 'lastWeek', 'thisMonth'];
  period = signal<Period>('thisWeek');
  /** 押したマス（もう一度押すと閉じる） */
  picked = signal<{ importance: Level; urgency: Level } | null>(null);

  /** クローズ・却下（ふだん見張っていないので、開いたときに1回だけ読む） */
  private closed = signal<Issue[] | null>(null);
  closedLoadError = signal(false);

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  settings = computed(() => ({ ...DEFAULT_SETTINGS, ...(this.ctx.project()?.settings ?? {}) }));

  // ---- 今 ----
  now = computed(() => nowStats(this.ctx.openIssues(), this.clock.now(), this.settings().staleDays));
  overLimit = computed(() => this.now().high > this.settings().highPriorityLimit);
  private cells = computed(() => matrix(this.ctx.openIssues(), this.clock.now()));
  pickedIssues = computed(() => {
    const p = this.picked();
    return p ? this.cellOf(p.importance, p.urgency).issues : [];
  });

  // ---- 期間 ----
  private range = computed(() => periodRange(this.period(), this.clock.now(), this.tz()));
  rangeLabel = computed(() => {
    const r = this.range();
    const fmt = new Intl.DateTimeFormat(this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US',
      { timeZone: this.tz(), month: 'numeric', day: 'numeric', weekday: 'short' });
    return this.i18n.t('dashboard.range', { from: fmt.format(r.from), to: fmt.format(r.to - 1) });
  });
  /** 期間の集計に使う課題：未クローズは見張りの最新、クローズ・却下は開いたときに読んだもの */
  all = computed(() => {
    const closed = this.closed();
    return closed ? [...this.ctx.openIssues(), ...closed] : null;
  });
  resolved = computed(() => {
    const a = this.all();
    const r = this.range();
    return a ? resolvedIn(a, r.from, r.to) : [];
  });
  avgDays = computed(() => avgResolveDays(this.resolved()));
  causes = computed(() => byCause(this.resolved()));
  causeMax = computed(() => Math.max(1, ...this.causes().map((c) => c.n)));
  /** メンバー別：管理者は全員、それ以外は自分の行だけ（制約【1】） */
  rows = computed(() => {
    const a = this.all();
    if (!a) return [];
    const r = this.range();
    const list = memberRows(this.ctx.members(), a, r.from, r.to, this.clock.now());
    return this.ctx.role() === 'admin' ? list : list.filter((x) => x.uid === this.myUid);
  });

  async ngOnInit() {
    try {
      const list = await this.issueService.listAll(this.ctx.pid());
      // 未クローズは見張りの分を使うので、ここではクローズ・却下だけを取っておく（削除フォルダは数えない）
      this.closed.set(list.filter((i) => !OPEN_STATUSES.includes(i.status) && i.status !== 'deleted'));
    } catch (e) {
      console.error(e);
      this.closedLoadError.set(true);
    }
  }

  cellOf(importance: Level, urgency: Level) {
    return this.cells().find((c) => c.importance === importance && c.urgency === urgency)!;
  }
  isPicked(importance: Level, urgency: Level) {
    const p = this.picked();
    return !!p && p.importance === importance && p.urgency === urgency;
  }
  pick(importance: Level, urgency: Level) {
    this.picked.set(this.isPicked(importance, urgency) ? null : { importance, urgency });
  }
  percent(v: number) {
    return Math.round(v * 100) + '%';
  }
}