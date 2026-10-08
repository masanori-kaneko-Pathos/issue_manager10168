import { Component, OnInit, WritableSignal, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IssueService } from '../../../core/issue.service';
import { Clock } from '../../../core/clock';
import { AuthService } from '../../../core/auth.service';
import { HelpTip } from '../../../shared/help-tip';
import { ISSUE_TYPES, Issue, IssueType, Label, Level, Member, OPEN_STATUSES, labelsOf } from '../../../core/models';
import { LabelChip } from '../../../shared/label-chip';
import { compareIssues, priorityOf } from '../../../core/priority';
import { formatDateTime, relativeTime, remainingOf, shortDue } from '../../../core/time';
import { I18nService, TPipe } from '../../../i18n/i18n';

type SortKey = 'priority' | 'due' | 'number' | 'updated';
type Dir = 'asc' | 'desc';

/** 並べ替えを選んだときの初期の向き */
const DEFAULT_DIR: Record<SortKey, Dir> = {
  priority: 'asc', due: 'asc', number: 'desc', updated: 'desc',
};

/** 全角・半角、大文字・小文字をそろえる */
const normalize = (s: string) => s.normalize('NFKC').toLowerCase();

interface Seg { text: string; hit: boolean; }
interface Suggestion { issue: Issue; title: Seg[]; field?: string; snippet?: Seg[]; }

/** そろえた文字で探し、見つかった位置を「元の文字」の位置で返す */
function findMatch(text: string, q: string): [number, number] | null {
  let norm = '';
  const map: number[] = []; // そろえた文字の位置 → 元の文字の位置
  for (let i = 0; i < text.length; i++) {
    const n = text[i].normalize('NFKC').toLowerCase();
    norm += n;
    for (let k = 0; k < n.length; k++) map.push(i);
  }
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

/** 一致した部分とそれ以外に分ける（from〜to の範囲だけ） */
function segments(text: string, range: [number, number] | null, from = 0, to = text.length): Seg[] {
  if (!range) return [{ text: text.slice(from, to), hit: false }];
  const [s, e] = range;
  return [
    { text: text.slice(from, s), hit: false },
    { text: text.slice(s, e), hit: true },
    { text: text.slice(e, to), hit: false },
  ].filter((g) => g.text);
}

@Component({
  selector: 'app-issue-list',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelChip],
  host: { '(document:keydown.escape)': 'showFilters.set(false); suggestOpen.set(false)' },
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

      <div class="search-wrap">
        <input type="search" class="search" [ngModel]="q()" (ngModelChange)="onQ($event)"
          (focus)="suggestOpen.set(true)" (keydown)="onSearchKey($event)"
          role="combobox" [attr.aria-expanded]="suggestOpen() && !!q().trim()"
          [placeholder]="'list.searchPlaceholder' | t" />
        @if (suggestOpen() && q().trim()) {
          <div class="s-backdrop" (click)="suggestOpen.set(false)"></div>
          <ul class="suggest" role="listbox">
            @for (s of suggestions(); track s.issue.id; let idx = $index) {
              <li role="option" [class.active]="idx === active()" [attr.aria-selected]="idx === active()">
                <a [routerLink]="['/p', pid(), 'i', s.issue.id]" (click)="suggestOpen.set(false)">
                  <span class="s-title"><span class="num">#{{ s.issue.number }}</span> @for (g of s.title; track $index) {<span [class.hit]="g.hit">{{ g.text }}</span>}</span>
                  @if (s.snippet) {
                    <span class="s-snippet"><span class="s-field">{{ s.field! | t }}：</span>@for (g of s.snippet; track $index) {<span [class.hit]="g.hit">{{ g.text }}</span>}</span>
                  }
                </a>
              </li>
            } @empty {
              <li class="s-empty">{{ 'list.noMatch' | t }}</li>
            }
            @if (visible().length > suggestions().length) {
              <li class="s-more">
                <button type="button" (click)="suggestOpen.set(false)">
                  {{ 'list.showAll' | t: { n: '' + visible().length } }}</button>
              </li>
            }
          </ul>
        }
      </div>
      @if (q().trim()) { <p class="help">{{ 'list.searchNote' | t }}</p> }

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
              <span class="prio" [attr.data-p]="prio(i)"></span>
              <span class="num">#{{ i.number }}</span>
              <a class="name" [routerLink]="['/p', pid(), 'i', i.id]">{{ i.title }}</a>
          @for (l of rowLabels(i); track l.id) { <app-label-chip [label]="l" /> }
              @if (i.status !== 'open') { <span class="st">{{ 'status.' + i.status | t }}</span> }
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
    .search-wrap { position: relative; margin-top: 8px; }
    .search { position: relative; z-index: 12; width: 100%; box-sizing: border-box; min-height: 44px;
      font-size: 16px; padding: 0 12px; }
    .s-backdrop { position: fixed; inset: 0; z-index: 11; }
    .suggest { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 12; list-style: none;
      margin: 0; padding: 4px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15); max-height: 60vh; overflow: auto; }
    .suggest a { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px;
      text-decoration: none; color: var(--text); }
    .suggest li.active a, .suggest a:hover { background: var(--surface-alt); }
    .s-title { font-size: 14px; overflow-wrap: anywhere; }
    .s-snippet { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .s-field { color: var(--text-subtle); }
    .hit { background: var(--warning-bg); color: var(--text); font-weight: bold; border-radius: 2px; }
    .s-empty { padding: 8px 12px; color: var(--text-muted); font-size: 13px; }
    .s-more button { width: 100%; min-height: 40px; border: none; border-top: 1px solid var(--border);
      background: none; color: var(--primary); font-size: 13px; cursor: pointer; }
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
    .prio { width: 10px; height: 10px; border-radius: 50%; background: var(--disabled); flex: none; }
    .prio[data-p='high'] { background: var(--danger); }
    .prio[data-p='mid'] { background: var(--warning); }
    .prio[data-p='low'] { background: var(--success); }
    .num { color: var(--text-muted); font-size: 13px; }
    .st { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--surface-muted); }
    .meta, .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .empty { color: var(--text-muted); padding: 12px 8px; }
    .denied-wrap { display: inline-flex; align-items: center; gap: 8px; }
  `,
})
export class IssueList implements OnInit {
  pid = input.required<string>();
  members = input.required<Member[]>();
  canCreate = input(false);
  isViewer = input(false);
  labels = input<Label[]>([]);

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  protected i18n = inject(I18nService);

  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly sortKeys: SortKey[] = ['priority', 'due', 'number', 'updated',];

  private openIssues = signal<Issue[]>([]);
  private allIssues = signal<Issue[] | null>(null);
  loading = signal(true);
  showFilters = signal(false);
  suggestOpen = signal(false);
  active = signal(-1); // ↑↓キーで選んでいる候補（-1 は未選択）

  // 条件（URLと同期する）
  q = signal('');
  scope = signal<'open' | 'all'>('open');
  assignee = signal<string | null>(null);
  type = signal<IssueType | null>(null);
  priority = signal<Level | null>(null);
  overdueOnly = signal(false);
  label = signal<string | null>(null);
  sort = signal<SortKey>('priority');
  dir = signal<Dir>('asc');

  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));
  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  activeCount = computed(() =>
    [this.scope() === 'all', this.type(), this.priority(), this.label(), this.overdueOnly()].filter(Boolean).length);
  hasCondition = computed(() => !!this.q().trim() || !!this.assignee() || this.activeCount() > 0);

  visible = computed(() => {
    const now = this.clock.now();
    const q = normalize(this.q().trim());
    // 検索語があるときと「すべて」のときは、クローズ済みも含める
    const useAll = !!q || this.scope() === 'all';
    let list = useAll && this.allIssues() ? this.allIssues()! : this.openIssues();

    if (q) {
      list = list.filter((i) =>
        [i.title, i.description, i.cause, i.countermeasure, i.learning, '#' + i.number]
          .some((text) => !!text && normalize(text).includes(q)));
    }
    const assignee = this.assignee();
    if (assignee) list = list.filter((i) => i.assigneeId === assignee);
    const type = this.type();
    if (type) list = list.filter((i) => i.type === type);
    const priority = this.priority();
    if (priority) list = list.filter((i) => priorityOf(i, now) === priority);
    const label = this.label();
    if (label) list = list.filter((i) => (i.labelIds ?? []).includes(label));
    if (this.overdueOnly()) list = list.filter((i) => this.isActive(i) && i.dueAt.toMillis() < now);

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

    /** 検索の候補（最大8件）。一覧と同じ条件・並び順で、一致した場所を添える */
    suggestions = computed<Suggestion[]>(() => {
      const q = normalize(this.q().trim());
      if (!q) return [];
      const out: Suggestion[] = [];
      for (const i of this.visible()) {
        const inTitle = findMatch(i.title, q);
        if (inTitle) {
          out.push({ issue: i, title: segments(i.title, inTitle) });
        } else {
          const fields: [string, string | undefined][] = [
            ['issue.description', i.description],
            ['workflow.cause', i.cause],
            ['workflow.countermeasure', i.countermeasure],
            ['workflow.learning', i.learning],
          ];
          let added = false;
          for (const [label, text] of fields) {
            if (!text) continue;
            const m = findMatch(text, q);
            if (!m) continue;
            // 一致した部分の前20文字・後ろ40文字だけ抜き出す
            const from = Math.max(0, m[0] - 20);
            const to = Math.min(text.length, m[1] + 40);
            out.push({
              issue: i,
              title: segments(i.title, null),
              field: label,
              snippet: [
                ...(from > 0 ? [{ text: '…', hit: false }] : []),
                ...segments(text, m, from, to),
                ...(to < text.length ? [{ text: '…', hit: false }] : []),
              ],
            });
            added = true;
            break;
          }
          // 番号（#3 など）で見つかったもの
          if (!added) out.push({ issue: i, title: segments(i.title, null) });
        }
        if (out.length >= 8) break;
      }
      return out;
    });

  async ngOnInit() {
    // URLから条件を復元する
    const p = this.route.snapshot.queryParamMap;
    this.q.set(p.get('q') ?? '');
    this.scope.set(p.get('scope') === 'all' ? 'all' : 'open');
    this.assignee.set(p.get('assignee'));
    this.type.set(p.get('type') as IssueType | null);
    this.priority.set(p.get('priority') as Level | null);
    this.overdueOnly.set(p.get('overdue') === '1');
    this.label.set(p.get('label'));
    const s = p.get('sort') as SortKey | null;
    if (s && this.sortKeys.includes(s)) {
      this.sort.set(s);
      const d = p.get('dir');
      this.dir.set(d === 'asc' || d === 'desc' ? d : DEFAULT_DIR[s]);
    }
    

    try {
      this.openIssues.set(await this.issueService.listOpen(this.pid()));
      await this.ensureAll();
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
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
        label: this.label(),
        sort: this.sort() === 'priority' ? null : this.sort(),
        dir: this.dir() === DEFAULT_DIR[this.sort()] ? null : this.dir(),
      },
    });
    this.ensureAll();
  }

  setQ(value: string) { this.q.set(value); this.changed(); }
  onQ(value: string) {
    this.setQ(value);
    this.active.set(-1);
    this.suggestOpen.set(true);
  }

  /** ↑↓で候補を選び、Enterで開く */
  onSearchKey(e: KeyboardEvent) {
    const n = this.suggestions().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.suggestOpen.set(true);
      this.active.set(Math.min(n - 1, this.active() + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.set(Math.max(-1, this.active() - 1));
    } else if (e.key === 'Enter') {
      const s = this.suggestions()[this.active()];
      if (s) this.router.navigate(['/p', this.pid(), 'i', s.issue.id]);
      this.suggestOpen.set(false);
    }
  }
  setScope(s: 'open' | 'all') { this.scope.set(s); this.changed(); }
  setSort(k: SortKey) { this.sort.set(k); this.dir.set(DEFAULT_DIR[k]); this.changed(); }
  flipDir() { this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc'); this.changed(); }
  toggleOverdue() { this.overdueOnly.set(!this.overdueOnly()); this.changed(); }

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
    this.changed();
  }

  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
  }
  memberName(uid: string) {
    return this.members().find((m) => m.uid === uid)?.displayName ?? '—';
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