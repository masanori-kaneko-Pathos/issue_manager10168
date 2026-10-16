import { Component, DestroyRef, OnInit, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IssueService } from '../../core/issue/issue.service';
import { auth } from '../../core/firebase';
import { ProjectContext } from './project-context';
import { Clock } from '../../core/time/clock';
import { AuthService } from '../../core/auth/auth.service';
import { HelpTip } from '../../shared/help-tip';
import { 
  DEFAULT_SETTINGS, ISSUE_TYPES, Issue, IssueType, Level, OPEN_STATUSES, labelsOf, hasWorkaround,
 } from '../../core/models';
import { LabelChip } from '../../shared/label-chip';
import { PriorityMark } from '../../shared/priority-mark';
import { compareIssues, isManualPriority, isStale, priorityOf } from '../../core/issue/priority';
import { formatDateTime, relativeTime, remainingOf, shortDue } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { csvFileName, downloadText, issuesToCsv } from '../../core/issue/csv';
import { issueMatches, terms } from '../../core/search/match';

type SortKey = 'priority' | 'due' | 'number' | 'updated';
type Dir = 'asc' | 'desc';

/** 並べ替えを選んだときの初期の向き */
const DEFAULT_DIR: Record<SortKey, Dir> = {
  priority: 'asc', due: 'asc', number: 'desc', updated: 'desc',
};

@Component({
  selector: 'app-tab-list',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelChip, PriorityMark],
  host: { '(document:keydown.escape)': 'showFilters.set(false)' },
  template: `
    <section>
      <div class="section-head">
        <h2>{{ 'project.issues' | t }}</h2>
        @if (canCreate()) {
          <a class="primary" [routerLink]="['/p', pid(), 'new']">{{ 'project.newIssue' | t }}</a>
               } @else {
          <span class="denied-wrap">
            <button type="button" class="primary" disabled>{{ 'project.newIssue' | t }}</button>
            <app-help-tip kind="denied" align="right"
              [keys]="[isViewer() ? 'help.viewerCannotCreate' : 'help.archivedCannotCreate']" />
          </span>
        }
      </div>

      @if (deletedNotice(); as d) {
        <div class="notice" role="status">
          <span>{{ (d.undone ? 'delete.undone' : 'delete.moved') | t: { n: '' + d.number } }}</span>
          @if (!d.undone) {
            <button type="button" class="link" [disabled]="undoBusy()" (click)="undoDelete(d.iid)">
              {{ 'delete.undo' | t }}</button>
          }
          <a class="link" [routerLink]="['/p', pid(), 'trash']">{{ 'trash.open' | t }}</a>
          <button type="button" class="link" (click)="deletedNotice.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (q().trim()) {
        <div class="qchip" role="status">
          <span>{{ 'list.searching' | t: { q: q().trim() } }}</span>
          <button type="button" class="link" (click)="clearQ()">{{ 'list.clearSearch' | t }}</button>
        </div>
      }

      <div class="avatars">
        @for (m of assignable(); track m.uid) {
          <button type="button" class="avatar" [class.on]="assignee() === m.uid"
            [attr.aria-label]="m.displayName" [title]="m.displayName" (click)="toggle(assignee, m.uid)">
            @if (m.photoURL) {
              <img [src]="m.photoURL" alt="" referrerpolicy="no-referrer" />
            } @else {
              {{ m.displayName.slice(0, 1) }}
            }
          </button>
        }
      </div>

      <div class="toolbar">
        <div class="filter-wrap">
          <button type="button" class="summary" [attr.aria-expanded]="showFilters()"
            [attr.aria-label]="'list.filters' | t" (click)="showFilters.set(!showFilters())">
            <span class="icon" aria-hidden="true">⚲</span>
            <span class="cond" [class.on]="scope() === 'all'">
              <span class="k">{{ 'list.status' | t }}</span>{{ (scope() === 'all' ? 'list.scopeAll' : 'list.scopeOpen') | t }}
            </span>
            <span class="cond" [class.on]="!!type()">
              <span class="k">{{ 'issue.type' | t }}</span>{{ type() ? ('issueTypes.' + type() | t) : ('list.any' | t) }}
            </span>
            <span class="cond" [class.on]="!!priority()">
              <span class="k">{{ 'issue.priority' | t }}</span>{{ priority() ? ('priority.' + priority() | t) : ('list.any' | t) }}
            </span>
            @if (label()) {
              <span class="cond on"><span class="k">{{ 'issue.labelIds' | t }}</span>{{ labelName(label()!) }}</span>
            }
            @if (assignee()) {
              <span class="cond on"><span class="k">{{ 'issue.assignee' | t }}</span>{{ memberName(assignee()!) }}</span>
            }
            @if (overdueOnly()) {
              <span class="cond on">{{ 'list.overdue' | t }}</span>
            }
            @if (staleOnly()) {
              <span class="cond on">{{ 'stale.filter' | t }}</span>
            }
            
          </button>

          @if (showFilters()) {
            <div class="backdrop" (click)="showFilters.set(false)"></div>
            <div class="panel" role="dialog" [attr.aria-label]="'list.filters' | t">
              <p class="label">{{ 'list.status' | t }}</p>
              <div class="chips">
                <button type="button" [class.on]="scope() === 'open'" (click)="setScope('open')">{{ 'list.scopeOpen' | t }}</button>
                <button type="button" [class.on]="scope() === 'all'" (click)="setScope('all')">{{ 'list.scopeAll' | t }}</button>
              </div>

              <p class="label">{{ 'issue.type' | t }}</p>
              <div class="chips">
                <button type="button" [class.on]="!type()" (click)="reset(type)">{{ 'list.any' | t }}</button>
                @for (t of types; track t) {
                  <button type="button" [class.on]="type() === t" (click)="toggle(type, t)">{{ 'issueTypes.' + t | t }}</button>
                }
              </div>

              <p class="label">{{ 'issue.priority' | t }}</p>
              <div class="chips">
                <button type="button" [class.on]="!priority()" (click)="reset(priority)">{{ 'list.any' | t }}</button>
                @for (l of levels; track l) {
                  <button type="button" [class.on]="priority() === l" (click)="toggle(priority, l)">{{ 'priority.' + l | t }}</button>
                }
              </div>
              @if (labels().length) {
                <p class="label">{{ 'issue.labelIds' | t }}</p>
                <div class="chips">
                  <button type="button" [class.on]="!label()" (click)="reset(label)">{{ 'list.any' | t }}</button>
                  @for (l of labels(); track l.id) {
                    <button type="button" [class.on]="label() === l.id" (click)="toggle(label, l.id)">{{ l.name }}</button>
                  }
                </div>
              }
              <p class="label">{{ 'issue.due' | t }}</p>
              <div class="chips">
                <button type="button" [class.on]="overdueOnly()" (click)="toggleOverdue()">{{ 'list.overdue' | t }}</button>
                <button type="button" [class.on]="staleOnly()" (click)="toggleStale()">{{ 'stale.filter' | t }}</button>
              </div>

              <div class="footer">
                <button type="button" class="link" (click)="clearFilters()">{{ 'list.clear' | t }}</button>
                <button type="button" class="close" (click)="showFilters.set(false)">{{ 'list.close' | t }}</button>
              </div>
            </div>
          }
        </div>

        <label class="sort">
          <span class="sort-label">{{ 'list.sort' | t }}</span>
          <select [ngModel]="sort()" (ngModelChange)="setSort($event)">
            @for (k of sortKeys; track k) {
              <option [value]="k">{{ 'list.sortKeys.' + k | t }}</option>
            }
          </select>
        </label>
        <button type="button" class="dir" (click)="flipDir()" [attr.aria-label]="'list.flip' | t">
          {{ dir() === 'asc' ? '↑' : '↓' }}
        </button>
      </div>

      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <p class="count">{{ 'list.count' | t: { n: '' + visible().length } }}</p>
        <ul class="list">
          @for (i of visible(); track i.id) {
            <li class="issue" [class.done]="!isActive(i)">
              @if (isActive(i)) {
                <app-priority-mark [level]="prio(i)" [manual]="manual(i)" showText />
              } @else {
                <span class="prio-none"></span>
              }
              <span class="num">#{{ i.number }}</span>
              <a class="name" [routerLink]="['/p', pid(), 'i', i.id]">{{ i.title }}</a>
          @for (l of rowLabels(i); track l.id) { <app-label-chip [label]="l" /> }
              @if (i.status !== 'open') { <span class="st">{{ 'status.' + i.status | t }}</span> }
              @if (stale(i)) {
                <span class="stale" [title]="'stale.title' | t: { n: '' + staleDays() }">{{ 'stale.label' | t }}</span>
              }
              @if (wa(i)) { <span class="wa">{{ 'workaround.label' | t }}</span> }
              <span class="meta">{{ memberName(i.assigneeId) }}</span>
               @if (sort() === 'updated') {
                <span class="meta" [title]="updatedFull(i)">{{ 'list.updated' | t: { t: updated(i) } }}</span>
              }
              @if (isActive(i) && isOverdue(i)) {
                <span class="due overdue" [title]="remaining(i)">{{ 'due.overdue' | t }} {{ dueLabel(i) }}</span>
              } @else if (isActive(i)) {
                <span class="due">{{ dueLabel(i) }}・{{ remaining(i) }}</span>
              } @else {
                <span class="due">{{ dueLabel(i) }}</span>
              }
            </li>
          } @empty {
            <li class="empty">{{ (hasCondition() ? 'list.noMatch' : 'project.noIssues') | t }}</li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 16px; }
    .primary { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px;
      background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; text-decoration: none; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    .notice { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 8px 0;
      padding: 4px 12px; border-radius: 8px; background: var(--surface-alt); font-size: 13px; }
    .notice span { flex: 1; min-width: 50%; }
    .notice a.link { display: inline-flex; align-items: center; min-height: 40px; text-decoration: none; }
    .qchip { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 8px;
      padding: 4px 12px; border-radius: 8px; background: var(--primary-bg); font-size: 13px; }
    .qchip span { flex: 1; min-width: 50%; overflow-wrap: anywhere; }
    .avatars { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    .avatar { width: 36px; height: 36px; border-radius: 50%; border: 2px solid transparent; background: var(--primary-bg);
      padding: 0; overflow: hidden; font-size: 14px; display: flex; align-items: center; justify-content: center; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .avatar.on { border-color: var(--primary); }
        .toolbar { display: flex; align-items: center; gap: 8px; }
    .filter-wrap { position: relative; flex: 1; min-width: 0; }
    .summary { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; width: 100%;
      min-height: 40px; padding: 4px 10px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px;
      text-align: left; font-size: 13px; cursor: pointer; }
    .summary .icon { color: var(--text-subtle); }
    .cond { color: var(--text-secondary); white-space: nowrap; }
    .cond .k { color: var(--text-subtle); margin-right: 4px; }
    .cond.on { color: var(--primary); font-weight: bold; }
    .backdrop { position: fixed; inset: 0; z-index: 10; }
    .panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 11; width: min(420px, 90vw);
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
      padding: 12px; display: flex; flex-direction: column; gap: 6px; }
    .label { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips button { min-height: 36px; padding: 0 12px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 18px; font-size: 13px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .footer { display: flex; justify-content: space-between; align-items: center;
      border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; }
    .close { min-height: 40px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .sort { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-muted); }
    select { min-height: 40px; font-size: 14px; }
    .dir { min-width: 40px; min-height: 40px; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 8px; }
    @media (max-width: 600px) {
      .sort-label { display: none; }
      .backdrop { background: rgba(0, 0, 0, 0.3); }
      .panel { position: fixed; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 80vh;
        overflow: auto; border-radius: 16px 16px 0 0; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    }
    .count { font-size: 12px; color: var(--text-muted); margin: 8px 0 0; }
    .list { list-style: none; padding: 0; margin: 0; }
    .issue { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 52px;
      padding: 4px 8px; border-bottom: 1px solid var(--border); }
    .issue.done { color: var(--text-subtle); }
    .name { flex: 1; min-width: 50%; overflow-wrap: anywhere; }
    .issue app-priority-mark, .prio-none { width: 64px; flex: none; }
    .num { color: var(--text-muted); font-size: 13px; }
    .st { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--surface-muted); }
    .meta, .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .empty { color: var(--text-muted); padding: 12px 8px; }
    .denied-wrap { display: inline-flex; align-items: center; gap: 8px; }
    .stale { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--warning-bg); color: var(--warning-text); }
    .wa { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--hold-bg); }    
    `,
})
export class TabList implements OnInit {
  private ctx = inject(ProjectContext);
  /** 値は入れ物の共有の置き場から直接読む（読むだけなので asReadonly） */
  pid = this.ctx.pid.asReadonly();
  members = this.ctx.members.asReadonly();
  canCreate = this.ctx.canCreate;
  isViewer = computed(() => this.ctx.role() === 'viewer');
  labels = computed(() => this.ctx.project()?.labels ?? []);

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  protected i18n = inject(I18nService);

  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly sortKeys: SortKey[] = ['priority', 'due', 'number', 'updated',];


  /** 未クローズは置き場の見張りから。「すべて」と検索のときだけ、クローズ済みを1回読む */
  private openIssues = computed(() => this.ctx.openIssues());
  private allIssues = signal<Issue[] | null>(null);
  loading = computed(() => this.ctx.issuesLoading());
  showFilters = signal(false);

  /** 詳細画面で削除して戻ってきたときの知らせ（undone＝元に戻した）。
   *  このタブは、入れ物がプロジェクトを読み終えてから作られ、そのときにはもう移動が終わっている。
   *  そのため、移動の最中にしか読めない currentNavigation ではなく、履歴に残った state から読む */
  deletedNotice = signal<{ iid: string; number: number; undone: boolean } | null>((() => {
    const d = (history.state as Record<string, unknown> | null)?.['deleted'] as
      { iid: string; number: number } | undefined;
    return d ? { ...d, undone: false } : null;
  })());
  undoBusy = signal(false);

  // 条件（URLと同期する）
  q = signal('');
  scope = signal<'open' | 'all'>('open');
  assignee = signal<string | null>(null);
  type = signal<IssueType | null>(null);
  priority = signal<Level | null>(null);
  overdueOnly = signal(false);
  staleOnly = signal(false);
  /** 停滞とみなす日数（プロジェクトの設定。なければ既定の7日） */
  staleDays = computed(() => this.ctx.project()?.settings?.staleDays ?? DEFAULT_SETTINGS.staleDays);
  label = signal<string | null>(null);
  sort = signal<SortKey>('priority');
  dir = signal<Dir>('asc');

  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));
  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  activeCount = computed(() =>
    [this.scope() === 'all', this.type(), this.priority(), this.label(), this.overdueOnly(), this.staleOnly()]
      .filter(Boolean).length);
  hasCondition = computed(() => !!this.q().trim() || !!this.assignee() || this.activeCount() > 0);

  visible = computed(() => {
    const now = this.clock.now();
    const ts = terms(this.q());
    // 検索語があるときと「すべて」のときは、クローズ済みも含める
    const useAll = ts.length > 0 || this.scope() === 'all';
    // 「すべて」のときも、未クローズの分は見張りの最新を使い、クローズ済みの分だけ1回読んだものを足す
    let list = useAll && this.allIssues()
      ? [...this.openIssues(), ...this.allIssues()!.filter((i) => !OPEN_STATUSES.includes(i.status) && i.status !== 'deleted')]
      : this.openIssues();

    // ヘッダーの検索と同じ決まり（空白で区切ると、すべての語を含む）
    if (ts.length) list = list.filter((i) => issueMatches(i, ts));
    const assignee = this.assignee();
    if (assignee) list = list.filter((i) => i.assigneeId === assignee);
    const type = this.type();
    if (type) list = list.filter((i) => i.type === type);
    const priority = this.priority();
    if (priority) list = list.filter((i) => priorityOf(i, now) === priority);
    const label = this.label();
    if (label) list = list.filter((i) => (i.labelIds ?? []).includes(label));
    if (this.overdueOnly()) list = list.filter((i) => this.isActive(i) && i.dueAt.toMillis() < now);
    if (this.staleOnly()) list = list.filter((i) => isStale(i, this.staleDays(), now));

    const cmp: Record<SortKey, (a: Issue, b: Issue) => number> = {
      priority: (a, b) => compareIssues(a, b, now),
      due: (a, b) => a.dueAt.toMillis() - b.dueAt.toMillis(),
      number: (a, b) => a.number - b.number,
      updated: (a, b) => a.updatedAt.toMillis() - b.updatedAt.toMillis(),
    };
    const sign = this.dir() === 'asc' ? 1 : -1;
    const by = cmp[this.sort()];
    return [...list].sort((a, b) => sign * by(a, b));
  });

  constructor() {
    // 今見えている一覧を、「⋮」の書き出しのために置き場へ出す。リストのタブを離れたら空にする
    effect(() => this.ctx.listView.set(this.visible()));
    inject(DestroyRef).onDestroy(() => this.ctx.listView.set(null));
  }

  async ngOnInit() {
    // 削除の知らせは1回だけ。読んだら履歴から消し、再読み込みで出し直さない
    const { deleted, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    if (deleted !== undefined) history.replaceState(rest, '');
    // URLから条件を復元する
    const p = this.route.snapshot.queryParamMap;
    this.q.set(p.get('q') ?? '');
    this.scope.set(p.get('scope') === 'all' ? 'all' : 'open');
    this.assignee.set(p.get('assignee'));
    this.type.set(p.get('type') as IssueType | null);
    this.priority.set(p.get('priority') as Level | null);
    this.overdueOnly.set(p.get('overdue') === '1');
    this.staleOnly.set(p.get('stale') === '1');
    this.label.set(p.get('label'));
    const s = p.get('sort') as SortKey | null;
    if (s && this.sortKeys.includes(s)) {
      this.sort.set(s);
      const d = p.get('dir');
      this.dir.set(d === 'asc' || d === 'desc' ? d : DEFAULT_DIR[s]);
    }
    await this.ensureAll();
  }
  /** 必要になったときに1回だけ、クローズ済みも含めて読み込む */
  private async ensureAll() {
    if (this.allIssues() || (!this.q().trim() && this.scope() === 'open')) return;
    try {
      this.allIssues.set(await this.issueService.listAll(this.pid()));
    } catch (e) {
      console.error(e);
    }
  }

  /** 削除の直後の「元に戻す」 */
  async undoDelete(iid: string) {
    this.undoBusy.set(true);
    try {
      await this.issueService.restoreIssue(this.pid(), iid, auth.currentUser!.uid, this.tz());
      this.deletedNotice.update((d) => (d ? { ...d, undone: true } : d));
    } catch (e) {
      console.error(e);
    } finally {
      this.undoBusy.set(false);
    }
  }

  /** 条件が変わったら、URLを書き換えて、必要なら全件を読む */
  private changed() {
    this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParams: {
        q: this.q().trim() || null,
        scope: this.scope() === 'all' ? 'all' : null,
        assignee: this.assignee(),
        type: this.type(),
        priority: this.priority(),
        overdue: this.overdueOnly() ? '1' : null,
        stale: this.staleOnly() ? '1' : null,
        label: this.label(),
        sort: this.sort() === 'priority' ? null : this.sort(),
        dir: this.dir() === DEFAULT_DIR[this.sort()] ? null : this.dir(),
      },
    });
    this.ensureAll();
  }

  /** ヘッダーの検索から来た言葉の絞り込みを外す */
  clearQ() { this.q.set(''); this.changed(); }
  
  setScope(s: 'open' | 'all') { this.scope.set(s); this.changed(); }
  setSort(k: SortKey) { this.sort.set(k); this.dir.set(DEFAULT_DIR[k]); this.changed(); }
  flipDir() { this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc'); this.changed(); }
  toggleOverdue() { this.overdueOnly.set(!this.overdueOnly()); this.changed(); }
  toggleStale() { this.staleOnly.set(!this.staleOnly()); this.changed(); }

  /** 同じものをもう一度押すと解除 */
  toggle<T>(sig: WritableSignal<T | null>, value: T) {
    sig.set(sig() === value ? null : value);
    this.changed();
  }
  reset<T>(sig: WritableSignal<T | null>) {
    sig.set(null);
    this.changed();
  }

  clearFilters() {
    this.scope.set('open');
    this.assignee.set(null);
    this.type.set(null);
    this.priority.set(null);
    this.label.set(null);
    this.overdueOnly.set(false);
    this.staleOnly.set(false);
    this.changed();
  }

  /** 今見えている一覧（絞り込み・検索・並び順のまま）を、CSV にして保存させる */
  exportCsv() {
    const now = this.clock.now();
    const csv = issuesToCsv(this.visible(), {
      t: (k) => this.i18n.t(k),
      nameOf: (uid) => this.memberName(uid),
      labels: this.labels(),
      tz: this.tz(),
      nowMs: now,
    });
    downloadText(csvFileName(this.ctx.project()?.name, now, this.tz()), csv);
  }

  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  stale(i: Issue) {
    return isStale(i, this.staleDays(), this.clock.now());
  }
  wa(i: Issue) {
    return hasWorkaround(i);
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }
  memberName(uid: string) {
    return this.ctx.nameOf(uid);
  }
  updated(i: Issue) {
    return relativeTime(i.updatedAt.toMillis(), this.i18n.lang(), this.clock.now());
  }
  updatedFull(i: Issue) {
    return formatDateTime(i.updatedAt.toDate(), this.tz(), this.i18n.lang());
  }
  rowLabels(i: Issue) {
    return labelsOf(i.labelIds, this.labels());
  }
  labelName(id: string) {
    return this.labels().find((l) => l.id === id)?.name ?? '';
  }

  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}