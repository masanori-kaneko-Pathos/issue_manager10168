import { Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { EMPTY_STATUS_PAYLOAD, IssueService } from '../../core/issue.service';
import { Issue, IssueStatus, Level, labelsOf } from '../../core/models';
import { LabelChip } from '../../shared/label-chip';
import { compareIssues, priorityOf } from '../../core/priority';
import { ProjectContext } from '../../core/project-context';
import { endOfDayIn, remainingOf, shortDue } from '../../core/time';
import { Transition, availableTransitions } from '../../core/workflow';
import { HelpTip } from '../../shared/help-tip';
import { StatusDialog } from '../../shared/status-dialog';
import { I18nService, TPipe } from '../../i18n/i18n';

type ColKey = 'open' | 'in_progress' | 'resolved' | 'done' | 'on_hold';
type DueFilter = 'today' | 'week' | 'overdue';

/** 列 → その列に置いたときのステータス */
const COL_STATUS: Record<ColKey, IssueStatus> = {
  open: 'open', in_progress: 'in_progress', resolved: 'resolved', done: 'closed', on_hold: 'on_hold',
};

function colOf(status: IssueStatus): ColKey | null {
  switch (status) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'on_hold': return 'on_hold';
    case 'resolved': return 'resolved';
    case 'closed': return 'done';
    default: return null; // 却下はかんばんに出さない
  }
}

const EMPTY_PAYLOAD = {
  reason: '', cause: '', countermeasure: '', causeCategory: null, effect: null, learning: '', doneCriteriaMet: false,
};

@Component({
  selector: 'app-project-board',
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, CdkScrollable, RouterLink, TPipe, HelpTip, StatusDialog, LabelChip],
  template: `
    <div class="quick">
      <div class="chips">
        <button type="button" [class.on]="!mine()" (click)="setMine(false)">{{ 'board.all' | t }}</button>
        <button type="button" [class.on]="mine()" (click)="setMine(true)">{{ 'board.mine' | t }}</button>
      </div>
      <div class="chips">
        <button type="button" [class.on]="!due()" (click)="setDue(null)">{{ 'board.dueAll' | t }}</button>
        @for (d of dueOptions; track d) {
          <button type="button" [class.on]="due() === d" (click)="setDue(d)">{{ 'board.due.' + d | t }}</button>
        }
      </div>
      @if (ctx.role() === 'viewer') {
        <app-help-tip kind="denied" align="right" [keys]="['board.viewerCannotMove']" />
      }
    </div>

    @if (loading()) {
      <p>{{ 'common.loading' | t }}</p>
    } @else {
      @if (isMobile()) {
        <div class="col-tabs">
          @for (c of mobileCols; track c) {
            <button type="button" [class.on]="mobileCol() === c" [attr.data-col]="c" (click)="scrollToCol(c)">
              {{ 'board.cols.' + c | t }} <span class="count">{{ byCol()[c].length }}</span>
            </button>
          }
        </div>
      }

      <div class="board" #boardEl cdkDropListGroup cdkScrollable [class.dragging]="!!dragging()"
        (scroll)="onBoardScroll()">
        @for (c of visibleCols(); track c) {
          @let collapsed = c === 'on_hold' && !holdOpen() && !isMobile();
          <section class="col" [attr.data-col]="c" [class.collapsed]="collapsed"
            [class.allowed]="!!dragging() && canDropInto(c)" [class.blocked]="!!dragging() && !canDropInto(c)"
            cdkDropList [cdkDropListData]="c" [cdkDropListEnterPredicate]="predicates[c]"
            (cdkDropListDropped)="onDrop($event)">
            <header class="col-head" [class.clickable]="c === 'on_hold' && !isMobile()"
              (click)="c === 'on_hold' && !isMobile() && holdOpen.set(!holdOpen())">
              <span class="col-name">{{ 'board.cols.' + c | t }}</span>
              <span class="count">{{ byCol()[c].length }}</span>
              @if (c === 'done' && !collapsed) { <span class="note">{{ 'board.doneNote' | t }}</span> }
            </header>

            @if (!collapsed) {
              <div class="cards">
                @for (i of byCol()[c]; track i.id) {
                  <article class="card" cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canDrag(i)"
                    [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                    (cdkDragStarted)="dragging.set(i)" (cdkDragEnded)="dragging.set(null)"
                    [attr.data-p]="prio(i)" [class.closed]="i.status === 'closed'">
                    @if (isOverdue(i)) { <div class="band">{{ 'board.overdue' | t }}</div> }
                    <div class="body">
                      <div class="top">
                        <span class="num">#{{ i.number }}</span>
                        @if (isMobile() && moves(i).length) {
                          <button type="button" class="more" [attr.aria-label]="'board.move' | t"
                            (click)="menuFor.set(menuFor() === i.id ? null : i.id)">⋯</button>
                        }
                      </div>
                      <a class="title" [routerLink]="['/p', ctx.pid(), 'i', i.id]">{{ i.title }}</a>
                                            @let ls = cardLabels(i);
                      @if (ls.length) {
                        <div class="labels">
                          @for (l of ls.slice(0, 2); track l.id) { <app-label-chip [label]="l" /> }
                          @if (ls.length > 2) { <span class="more-labels">+{{ ls.length - 2 }}</span> }
                        </div>
                      }
                      <div class="meta">
                        <span class="avatar" [title]="memberName(i.assigneeId)">
                          @if (memberPhoto(i.assigneeId); as src) {
                            <img [src]="src" alt="" referrerpolicy="no-referrer" />
                          } @else {
                            {{ memberName(i.assigneeId).slice(0, 1) }}
                          }
                        </span>
                        @if (isActive(i)) {
                          <span class="due" [class.overdue]="isOverdue(i)">{{ dueLabel(i) }}・{{ remaining(i) }}</span>
                        } @else {
                          <span class="due">{{ dueLabel(i) }}</span>
                        }
                      </div>
                      @if (menuFor() === i.id) {
                        <div class="moves">
                          @for (a of moves(i); track a.t.key) {
                            <button type="button" (click)="menuFor.set(null); start(i, a.t)">{{ 'workflow.' + a.t.key | t }}</button>
                          }
                        </div>
                      }
                    </div>
                  </article>
                } @empty {
                  <p class="empty">{{ 'board.empty' | t }}</p>
                }
              </div>
              @if (c === 'open' && ctx.canCreate()) {
                <a class="add" [routerLink]="['/p', ctx.pid(), 'new']">{{ 'project.newIssue' | t }}</a>
              }
            }
          </section>
        }
      </div>
    }

    @if (pending(); as p) {
      <app-status-dialog [issue]="p.issue" [transition]="p.t" [pid]="ctx.pid()"
        (done)="onDialogDone()" (cancel)="pending.set(null)" />
    }
  `,
  styles: `
    .quick { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips button { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 18px; font-size: 13px; cursor: pointer; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }

    .board { position: relative; display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
    .col { flex: 1 1 0; min-width: 220px; background: var(--surface-alt); border-radius: 10px;
      border-top: 4px solid var(--disabled); display: flex; flex-direction: column; }
    .col[data-col='in_progress'] { border-top-color: var(--primary); }
    .col[data-col='resolved'] { border-top-color: var(--success); }
    .col[data-col='done'] { border-top-color: var(--text-muted); }
    .col[data-col='on_hold'] { border-top-color: var(--warning); }
    .col.collapsed { flex: 0 0 48px; min-width: 48px; }
    .col.allowed { outline: 2px dashed var(--primary); outline-offset: -2px; }
    .col.blocked { opacity: 0.45; }

    .col-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; font-weight: bold; font-size: 14px; }
    .col-head.clickable { cursor: pointer; }
    .collapsed .col-head { writing-mode: vertical-rl; padding: 10px 0; align-self: center; }
    .count { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface); }
    .note { font-size: 11px; font-weight: normal; color: var(--text-subtle); flex-basis: 100%; }

    .cards { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; min-height: 40px; }
    .card { background: var(--surface); border-radius: 8px; border-left: 4px solid var(--disabled);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); overflow: hidden; cursor: grab; }
    .card[data-p='high'] { border-left-color: var(--danger); }
    .card[data-p='mid'] { border-left-color: var(--warning); }
    .card[data-p='low'] { border-left-color: var(--success); }
    .card.closed .title { text-decoration: line-through; color: var(--text-muted); }
    .band { background: var(--danger-bg); color: var(--danger-text); font-size: 11px; font-weight: bold; padding: 2px 10px; }
    .body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .top { display: flex; align-items: center; justify-content: space-between; }
    .num { font-size: 12px; color: var(--text-muted); }
    .more { min-width: 36px; min-height: 32px; border: none; background: none; font-size: 18px; color: var(--text-muted); }
    .title { color: var(--text); text-decoration: none; font-size: 14px; overflow-wrap: anywhere; }
    .labels { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .more-labels { font-size: 11px; color: var(--text-muted); }
    .meta { display: flex; align-items: center; justify-content: space-between; }
    .avatar { width: 24px; height: 24px; border-radius: 50%; background: var(--primary-bg); overflow: hidden;
      display: flex; align-items: center; justify-content: center; font-size: 12px; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .moves { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
    .moves button { min-height: 40px; padding: 0 12px; border: 1px solid var(--primary); color: var(--primary);
      background: var(--surface); border-radius: 8px; font-size: 13px; }
    .empty { font-size: 12px; color: var(--text-subtle); text-align: center; margin: 8px 0; }
    .add { display: block; margin: 0 8px 8px; padding: 10px; text-align: center; border-radius: 8px;
      border: 1px dashed var(--border-strong); color: var(--primary); text-decoration: none; font-size: 13px; }

    /* ドラッグ中の見た目 */
    .cdk-drag-preview { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drag-animating { transition: transform 200ms ease; }

    /* スマホ：1列ずつ */
    .col-tabs { display: flex; gap: 6px; overflow-x: auto; margin-bottom: 8px; }
    .col-tabs button { flex: none; min-height: 40px; padding: 0 12px; border: 1px solid var(--border-strong);
      background: var(--surface); border-radius: 20px; font-size: 13px; white-space: nowrap; }
    .col-tabs button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    @media (max-width: 600px) {
      /* 1列ずつぴたっと止まる横スクロール。左右に隣の列が少し見える */
      .board { scroll-snap-type: x mandatory; overscroll-behavior-x: contain; gap: 8px;
        margin: 0 -16px; padding: 0 16px 8px; scroll-padding: 0 16px; scrollbar-width: none; }
      .board::-webkit-scrollbar { display: none; }
      .col { flex: 0 0 85%; min-width: 0; scroll-snap-align: center; }
      .card { cursor: default; -webkit-touch-callout: none; user-select: none; }
      /* つかんでいる間は、1列ずつ止まる仕組みを外し、端に運んだときになめらかに横へ流れるようにする */
      .board.dragging { scroll-snap-type: none; }
    }
  `,
})
export class ProjectBoard implements OnInit {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private i18n = inject(I18nService);

  readonly myUid = auth.currentUser!.uid;
  readonly dueOptions: DueFilter[] = ['today', 'week', 'overdue'];
  readonly mobileCols: ColKey[] = ['open', 'in_progress', 'resolved', 'done', 'on_hold'];

  issues = signal<Issue[]>([]);
  loading = signal(true);
  holdOpen = signal(false);
  mobileCol = signal<ColKey>('open');
  dragging = signal<Issue | null>(null);
  pending = signal<{ issue: Issue; t: Transition } | null>(null);
  menuFor = signal<string | null>(null);
  mine = signal(false);
  due = signal<DueFilter | null>(null);

  private mq = window.matchMedia('(max-width: 600px)');
  isMobile = signal(this.mq.matches);

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** スマホは横に並べてなでて移る。保留は「対応中」の隣に置く */
  visibleCols = computed<ColKey[]>(() =>
    this.isMobile() ? this.mobileCols : ['open', 'in_progress', 'resolved', 'done', 'on_hold']);

  private boardEl = viewChild<ElementRef<HTMLElement>>('boardEl');

  /** すばやい絞り込みをかけた課題 */
  filtered = computed(() => {
    const now = this.clock.now();
    let list = this.issues();
    if (this.mine()) list = list.filter((i) => i.assigneeId === this.myUid);
    const due = this.due();
    if (due) {
      const limit = due === 'today' ? endOfDayIn(0, this.tz()).getTime()
        : due === 'week' ? now + 7 * 24 * 60 * 60 * 1000
        : now;
      list = list.filter((i) => this.isActive(i) && i.dueAt.toMillis() <= limit);
    }
    return list;
  });

  /** 列ごとの課題。完了の列はクローズが新しい順、それ以外は優先度順 */
  byCol = computed(() => {
    const now = this.clock.now();
    const map: Record<ColKey, Issue[]> = { open: [], in_progress: [], resolved: [], done: [], on_hold: [] };
    for (const i of this.filtered()) {
      const k = colOf(i.status);
      if (k) map[k].push(i);
    }
    for (const k of Object.keys(map) as ColKey[]) {
      map[k].sort(k === 'done'
        ? (a, b) => (b.closedAt?.toMillis() ?? 0) - (a.closedAt?.toMillis() ?? 0)
        : (a, b) => compareIssues(a, b, now));
    }
    return map;
  });

  /** ドラッグ中のカードを、その列に落とせるか（CDKに渡す判定） */
  readonly predicates: Record<ColKey, (drag: CdkDrag<Issue>) => boolean> = {
    open: (d) => this.canMove(d.data, 'open'),
    in_progress: (d) => this.canMove(d.data, 'in_progress'),
    resolved: (d) => this.canMove(d.data, 'resolved'),
    done: (d) => this.canMove(d.data, 'done'),
    on_hold: (d) => this.canMove(d.data, 'on_hold'),
  };

  constructor() {
    const onChange = (e: MediaQueryListEvent) => this.isMobile.set(e.matches);
    this.mq.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.mq.removeEventListener('change', onChange));
  }

  async ngOnInit() {
    const p = this.route.snapshot.queryParamMap;
    this.mine.set(p.get('mine') === '1');
    const d = p.get('due');
    this.due.set(d === 'today' || d === 'week' || d === 'overdue' ? d : null);
    await this.load();
  }

  async load() {
    try {
      const [open, closed] = await Promise.all([
        this.issueService.listOpen(this.ctx.pid()),
        this.issueService.listRecentlyClosed(this.ctx.pid(), 7),
      ]);
      this.issues.set([...open, ...closed]);
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  // ---- 絞り込み（URLに残す） ----
  setMine(v: boolean) {
    this.mine.set(v);
    this.updateUrl();
  }
  /** null は「すべて」。同じものをもう一度押しても解除 */
  setDue(d: DueFilter | null) {
    this.due.set(d === null || this.due() === d ? null : d);
    this.updateUrl();
  }
  private updateUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: { mine: this.mine() ? '1' : null, due: this.due() },
    });
  }

  // ---- 移動 ----
  /** その人がこの課題でできる移動（却下はかんばんでは扱わない） */
  moves(i: Issue) {
    const role = this.ctx.role();
    if (!role) return [];
    return availableTransitions(i, role, this.myUid).filter((a) => a.allowed && a.t.key !== 'reject');
  }

  canDrag(i: Issue) {
    return this.moves(i).length > 0;
  }

  private canMove(i: Issue, col: ColKey) {
    if (colOf(i.status) === col) return true; // 元の列に戻すのはOK
    return this.moves(i).some((a) => a.t.to === COL_STATUS[col]);
  }

  /** 枠の強調用：今つかんでいるカードを、この列に落とせるか */
  canDropInto(col: ColKey) {
    const d = this.dragging();
    return !d || this.canMove(d, col);
  }

  onDrop(e: CdkDragDrop<ColKey, ColKey, Issue>) {
    this.dragging.set(null);
    if (e.previousContainer === e.container) return;
    const issue = e.item.data;
    const a = this.moves(issue).find((m) => m.t.to === COL_STATUS[e.container.data]);
    if (a) this.start(issue, a.t);
    // 一覧の並びはここでは変えない。保存できたら読み直すので、やめた場合は元の列に戻ったまま
  }

  /** 入力が要らない移動はすぐ保存、要るものはモーダルを開く */
  async start(issue: Issue, t: Transition) {
    if (t.needs !== 'none') {
      this.pending.set({ issue, t });
      return;
    }
    try {
      await this.issueService.changeStatus(this.ctx.pid(), issue, t, EMPTY_STATUS_PAYLOAD, this.myUid, this.tz());
      await this.load();
    } catch (e) {
      console.error(e);
    }
  }

  async onDialogDone() {
    this.pending.set(null);
    await this.load();
  }

  // ---- 表示用 ----
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }
  memberName(uid: string) {
    return this.ctx.members().find((m) => m.uid === uid)?.displayName ?? '—';
  }
  memberPhoto(uid: string) {
    return this.ctx.members().find((m) => m.uid === uid)?.photoURL ?? null;
  }
    // ---- スマホ：なでて列を移る ----
  /** 画面の真ん中に一番近い列を、今の列にする */
  onBoardScroll() {
    const el = this.boardEl()?.nativeElement;
    if (!el || !this.isMobile()) return;
    const center = el.scrollLeft + el.clientWidth / 2;
    let best = 0;
    let bestDist = Infinity;
    el.querySelectorAll<HTMLElement>('.col').forEach((c, i) => {
      const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - center);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    const key = this.mobileCols[best];
    if (key && key !== this.mobileCol()) this.mobileCol.set(key);
  }

  /** 列名のボタンを押したら、その列までスクロールする */
  scrollToCol(c: ColKey) {
    this.mobileCol.set(c);
    this.boardEl()?.nativeElement
      .querySelector<HTMLElement>(`.col[data-col="${c}"]`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
  cardLabels(i: Issue) {
    return labelsOf(i.labelIds, this.ctx.project()?.labels ?? []);
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}