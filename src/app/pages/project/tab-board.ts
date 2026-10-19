import {
  Component, DestroyRef, ElementRef, OnInit, afterEveryRender, computed, inject, signal, viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragMove, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { Unsubscribe } from 'firebase/firestore';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { ConflictError, EMPTY_STATUS_PAYLOAD, IssueService, conflictWho } from '../../core/issue/issue.service';
import { DEFAULT_SETTINGS, Issue, IssueStatus, Level, labelsOf, hasWorkaround } from '../../core/models';
import { LabelChip } from '../../shared/label-chip';
import { PriorityMark } from '../../shared/priority-mark';
import { compareIssues, isManualPriority, isStale, priorityOf } from '../../core/issue/priority';
import { ProjectContext } from './project-context';
import { dateKey, dueBucket, endOfDayIn, remainingOf, shortDue } from '../../core/time/time';
import { DueDialog } from '../../shared/due-dialog';
import { Transition, UNDO_OF, availableTransitions } from '../../core/issue/workflow';
import { UndoService } from '../../core/undo/undo.service';
import { HelpTip } from '../../shared/help-tip';
import { StatusDialog } from '../../shared/status-dialog';
import { I18nService, TPipe } from '../../i18n/i18n';

type ColKey = 'open' | 'in_progress' | 'resolved' | 'done' | 'on_hold';
type DueFilter = 'today' | 'week' | 'overdue';
/** 列の分け方（カタログ【5】）。ドラッグはステータス別のときだけ（赤AJ） */
type ViewBy = 'status' | 'due' | 'assignee';
type DueCol = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';
/** 期限別・担当者別の列（見るだけ） */
interface AltCol { key: string; label: string; issues: Issue[]; overdue: number; }
const DAY = 24 * 60 * 60 * 1000;

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
  selector: 'app-tab-board',
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, NgTemplateOutlet,
    CdkScrollable, RouterLink, TPipe, HelpTip, StatusDialog, LabelChip, PriorityMark, DueDialog],
  template: `
    <div class="quick">
      <div class="chips" role="group" [attr.aria-label]="'board.by' | t">
        @for (v of views; track v) {
          <button type="button" [class.on]="by() === v" [attr.aria-pressed]="by() === v"
            (click)="setBy(v)">{{ 'board.views.' + v | t }}</button>
        }
      </div>
      <div class="chips">
        <button type="button" [class.on]="!mine()" (click)="setMine(false)">{{ 'board.all' | t }}</button>
        <button type="button" [class.on]="mine()" (click)="setMine(true)">{{ 'board.mine' | t }}</button>
      </div>
      <!-- 「期限」の表示では、列そのものが期限で分かれているので出さない -->
      @if (by() !== 'due') {
        <div class="chips">
          <button type="button" [class.on]="!due()" (click)="setDue(null)">{{ 'board.dueAll' | t }}</button>
          @for (d of dueOptions; track d) {
            <button type="button" [class.on]="due() === d" (click)="setDue(d)">{{ 'board.due.' + d | t }}</button>
          }
        </div>
      }
      @if (by() === 'assignee') {
        <span class="view-note">{{ 'board.viewOnly' | t }}</span>
      } @else if (by() === 'due') {
        <span class="view-note">{{ 'board.dueDropHint' | t }}</span>
      } @else if (ctx.role() === 'viewer') {
        <app-help-tip kind="denied" align="right" [keys]="['board.viewerCannotMove']" />
      }
    </div>

    @if (notMoved(); as m) {
      @let w = who(m.latest);
      <p class="notice" role="status">{{ 'conflict.notMoved' | t: { n: '' + m.n } }} {{ w.key | t: w.params }}</p>
    }
    @if (loading()) {
      <p>{{ 'common.loading' | t }}</p>
    } @else {
      @if (isMobile()) {
        <div class="col-tabs">
          @for (c of tabCols(); track c.key) {
            <button type="button" [class.on]="mobileCol() === c.key" [attr.data-col]="c.key" (click)="scrollToCol(c.key)">
              {{ c.label }} <span class="count">{{ c.n }}</span>
            </button>
          }
        </div>
      }

      <!-- PC：上にも横スクロールのバー（本体と連動）。列が画面に収まっているときは出さない -->
      @if (!isMobile()) {
        <div class="top-scroll" #topScroll [class.off]="!overflowing()" (scroll)="onTopScroll()" aria-hidden="true">
          <div [style.width.px]="scrollWidth()"></div>
        </div>
      }

      @if (by() === 'status') {
        <div class="board" #boardEl cdkDropListGroup cdkScrollable [class.dragging]="!!dragging()"
          (scroll)="onBoardScroll()">
          @for (c of visibleCols(); track c) {
            @let collapsed = c === 'on_hold' && !holdOpen() && !isMobile();
            <section class="col" [attr.data-col]="c" [class.collapsed]="collapsed" [cdkDropListAutoScrollDisabled]="true"
              [class.allowed]="!!dragging() && canDropInto(c)" [class.blocked]="!!dragging() && !canDropInto(c)"
              cdkDropList [cdkDropListData]="c" [cdkDropListEnterPredicate]="predicates[c]"
              (cdkDropListDropped)="onDrop($event)">
              <header class="col-head" [class.clickable]="c === 'on_hold' && !isMobile()"
                (click)="c === 'on_hold' && !isMobile() && holdOpen.set(!holdOpen())">
                <span class="col-name">{{ 'board.cols.' + c | t }}</span>
                <span class="count">{{ byCol()[c].length }}</span>
                @if (c === 'open' && ctx.canCreate()) {
                  <a class="head-add" [routerLink]="['/p', ctx.pid(), 'new']"
                    [attr.aria-label]="'project.newIssue' | t" [title]="'project.newIssue' | t">＋</a>
                }
                @if (c === 'on_hold' && !isMobile()) { <span class="fold" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span> }
                @if (c === 'done' && !collapsed) { <span class="note">{{ 'board.doneNote' | t }}</span> }
              </header>
              @if (!collapsed) {
                <div class="cards">
                  @for (i of byCol()[c]; track i.id) {
                    <article class="card" cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canDrag(i)" (cdkDragMoved)="onDragMoved($event)"
                      [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                      (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnd()"
                      [attr.data-p]="isActive(i) ? prio(i) : null" [class.closed]="i.status === 'closed'">
                      <ng-container [ngTemplateOutlet]="cardBody" [ngTemplateOutletContext]="{ $implicit: i }" />
                    </article>
                  } @empty {
                    <p class="empty">{{ 'board.empty' | t }}</p>
                  }
                </div>
              }
            </section>
          }
        </div>
      } @else {
        <!-- 期限別：期限の列へドラッグできる（落とすと期限の変更の窓）。担当者別：見るだけ -->
        <div class="board" #boardEl cdkDropListGroup cdkScrollable [class.dragging]="!!dragging()" (scroll)="onBoardScroll()">
          @for (c of altCols(); track c.key) {
            <section class="col" [attr.data-col]="c.key" [cdkDropListAutoScrollDisabled]="true"
              cdkDropList [cdkDropListData]="c.key" [cdkDropListDisabled]="by() !== 'due'"
              [cdkDropListSortingDisabled]="true" [cdkDropListEnterPredicate]="dueEnter"
              [class.allowed]="!!dragging() && c.key !== 'overdue'" [class.blocked]="!!dragging() && c.key === 'overdue'"
              (cdkDropListDropped)="onDueDrop($event)">
              <header class="col-head">
                <span class="col-name">{{ c.label }}</span>
                <span class="count">{{ c.issues.length }}</span>
                @if (c.overdue) { <span class="od">{{ 'board.overdueN' | t: { n: '' + c.overdue } }}</span> }
              </header>
              <div class="cards">
                @for (i of c.issues; track i.id) {
                  @let movable = by() === 'due' && canMoveDue(i);
                  <article class="card" [class.static]="!movable" [attr.data-p]="prio(i)" (cdkDragMoved)="onDragMoved($event)"
                    cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!movable" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                    (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnd()">
                    <ng-container [ngTemplateOutlet]="cardBody" [ngTemplateOutletContext]="{ $implicit: i }" />
                  </article>
                } @empty {
                  <p class="empty">{{ 'board.empty' | t }}</p>
                }
              </div>
            </section>
          }
        </div>
      }
    }

    <!-- カードの中身（3つの表示で共通） -->
    <ng-template #cardBody let-i>
      @if (isOverdue(i)) { <div class="band">{{ 'board.overdue' | t }}</div> }
      <div class="body">
        <div class="top">
          <span class="id">
            @if (isActive(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> }
            <span class="num">#{{ i.number }}</span>
            @if (stale(i)) {
              <span class="stale" [title]="'stale.title' | t: { n: '' + staleDays() }">{{ 'stale.label' | t }}</span>
            }
            @if (wa(i)) { <span class="wa">{{ 'workaround.label' | t }}</span> }
          </span>
          @if (isMobile() && by() === 'status' && moves(i).length) {
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
        @if (i.subtaskTotal) {
          <span class="subs" [class.all]="i.subtaskDone === i.subtaskTotal"
            [title]="'subtask.progress' | t: { done: '' + (i.subtaskDone ?? 0), total: '' + i.subtaskTotal }"
            [attr.aria-label]="'subtask.progress' | t: { done: '' + (i.subtaskDone ?? 0), total: '' + i.subtaskTotal }">
            <span aria-hidden="true">☑ {{ i.subtaskDone ?? 0 }}/{{ i.subtaskTotal }}</span></span>
        }
        <div class="meta">
          <span class="avatar" [title]="memberName(i.assigneeId)">
            @if (memberPhoto(i.assigneeId); as src) {
              <img [src]="src" alt="" referrerpolicy="no-referrer" />
            } @else {
              {{ memberName(i.assigneeId).slice(0, 1) }}
            }
          </span>
          @if (isActive(i) && isOverdue(i)) {
            <span class="due overdue" [title]="remaining(i)">{{ dueLabel(i) }}</span>
          } @else if (isActive(i)) {
            <span class="due">{{ dueLabel(i) }}・{{ remaining(i) }}</span>
          } @else {
            <span class="due">{{ dueLabel(i) }}</span>
          }
        </div>
        @if (menuFor() === i.id && by() === 'status') {
          <div class="moves">
            @for (a of moves(i); track a.t.key) {
              <button type="button" (click)="menuFor.set(null); start(i, a.t)">{{ 'workflow.' + a.t.key | t }}</button>
            }
          </div>
        }
      </div>
    </ng-template>

    @if (pending(); as p) {
      <app-status-dialog [issue]="p.issue" [transition]="p.t" [pid]="ctx.pid()" [members]="ctx.members()"
        (done)="onDialogDone()" (cancel)="pending.set(null)" />
    }
    @if (pendingDue(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pickDate]="p.pick" [pid]="ctx.pid()" [members]="ctx.members()"
        (done)="pendingDue.set(null)" (cancel)="pendingDue.set(null)" />
    }
  `,
  styles: `
    .quick { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips button { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 18px; font-size: 13px; cursor: pointer; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .notice { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }

    .board { position: relative; display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
    .col { flex: 1 1 0; min-width: 220px; background: var(--surface-alt); border-radius: 10px;
      border-top: 4px solid var(--disabled); display: flex; flex-direction: column; }
    .col[data-col='in_progress'] { border-top-color: var(--primary); }
    .col[data-col='resolved'] { border-top-color: var(--success); }
    .col[data-col='done'] { border-top-color: var(--text-muted); }
    .col[data-col='on_hold'] { border-top-color: var(--warning); }
    .col.collapsed { flex: 0 0 96px; min-width: 96px; }
    .col.allowed { outline: 2px dashed var(--primary); outline-offset: -2px; }
    .col.blocked { opacity: 0.45; }

    .col-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; font-weight: bold; font-size: 14px; }
    .col-head.clickable { cursor: pointer; }
    .collapsed .col-head { justify-content: center; gap: 4px; padding: 8px 6px; white-space: nowrap; }
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
    .id { display: flex; align-items: center; gap: 6px; }
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
    .head-add { margin-left: auto; width: 32px; height: 32px; border-radius: 8px; display: inline-flex;
      align-items: center; justify-content: center; color: var(--primary); text-decoration: none;
      font-size: 18px; font-weight: bold; }
    .head-add:hover { background: var(--surface); }

    /* ドラッグ中の見た目 */
    .cdk-drag-preview { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drag-animating { transition: transform 200ms ease; }

    .top-scroll { overflow-x: auto; overflow-y: hidden; height: 14px; margin-bottom: 4px; }
    .top-scroll > div { height: 1px; }
    .top-scroll.off { visibility: hidden; height: 0; margin: 0; }

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
    .stale { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--warning-bg); color: var(--warning-text); }
    .wa { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--hold-bg); }
    .subs { align-self: flex-start; font-size: 12px; color: var(--text-muted); }
    .subs.all { color: var(--success-text); font-weight: bold; }    
    .fold { font-size: 12px; color: var(--text-muted); }
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
  private undo = inject(UndoService);


  readonly myUid = auth.currentUser!.uid;
  readonly dueOptions: DueFilter[] = ['today', 'week', 'overdue'];
  readonly mobileCols: ColKey[] = ['open', 'in_progress', 'resolved', 'done', 'on_hold'];

  /** 直近7日のクローズ（かんばんのタブを開いている間だけ見張る） */
  private recentClosed = signal<Issue[]>([]);
  private closedLoading = signal(true);
  private stopClosed: Unsubscribe | null = null;
  /** つかんでいる間は、つかんだ時点の並びのままにする（届いた変更は離したあとに反映） */
  private frozen = signal<Issue[] | null>(null);

  issues = computed(() => {
    const frozen = this.frozen();
    if (frozen) return frozen;
    // 開きっぱなしでも、7日を過ぎたものは完了の列から外す
    const since = this.clock.now() - 7 * 24 * 60 * 60 * 1000;
    const closed = this.recentClosed().filter((i) => (i.closedAt?.toMillis() ?? 0) >= since);
    return [...this.ctx.openIssues(), ...closed];
  });
  loading = computed(() => this.ctx.issuesLoading() || this.closedLoading());
  holdOpen = signal(false);
  /** スマホで今見ている列（ステータス・期限・担当者の、どの列の名前でも入る） */
  mobileCol = signal<string>('open');
  readonly views: ViewBy[] = ['status', 'due', 'assignee'];
  by = signal<ViewBy>('status');
  dragging = signal<Issue | null>(null);
  pending = signal<{ issue: Issue; t: Transition } | null>(null);
  /** 期限のかんばんで落としたあと、窓で確かめ中の変更（pick があれば、窓で日付も選ぶ） */
  pendingDue = signal<{ issue: Issue; date: string; pick: { min: string; max: string | null } | null } | null>(null);
  /** 期限切れの列には落とせない（わざわざ過去にする場面がないため。どうしても過去にするなら、詳細から） */
  readonly dueEnter = (_drag: CdkDrag<Issue>, drop: CdkDropList<string>) => drop.data !== 'overdue';
  menuFor = signal<string | null>(null);
  mine = signal(false);
  due = signal<DueFilter | null>(null);
  /** 移動できなかったときの知らせ（数秒で消える） */
  notMoved = signal<{ n: number; latest: Issue } | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  private mq = window.matchMedia('(max-width: 600px)');
  isMobile = signal(this.mq.matches);

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** スマホは横に並べてなでて移る。保留は「対応中」の隣に置く */
  visibleCols = computed<ColKey[]>(() =>
    this.isMobile() ? this.mobileCols : ['open', 'in_progress', 'resolved', 'done', 'on_hold']);

  private boardEl = viewChild<ElementRef<HTMLElement>>('boardEl');
  private topScroll = viewChild<ElementRef<HTMLElement>>('topScroll');
  /** 本体の横の長さ（上のバーの中身を、同じ長さにするため） */
  scrollWidth = signal(0);
  /** 列が画面からはみ出しているか（はみ出していなければ、上のバーは出さない） */
  overflowing = signal(false);
  /** 片方を動かしたとき、もう片方の「動いた」の知らせで動かし返さないための目印 */
  private syncing = false;

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

  /** 期限別・担当者別の列。どちらも未完了の課題だけ。並びはやる順（優先度 → 期限） */
  altCols = computed<AltCol[]>(() => {
    const now = this.clock.now();
    const list = this.filtered().filter((i) => this.isActive(i));
    const sorted = (xs: Issue[]) => xs.sort((a, b) => compareIssues(a, b, now));
    if (this.by() === 'due') {
      const keys: DueCol[] = ['overdue', 'today', 'tomorrow', 'week', 'later'];
      return keys.map((key) => ({
        key, label: this.i18n.t('board.dueCols.' + key),
        issues: sorted(list.filter((i) => this.dueCol(i, now) === key)), overdue: 0,
      }));
    }
    // 担当者別：担当者にできるメンバー（自分が先頭、あとは名前順）。件数の多い順にはしない（ランキングにしない）。
    // 抜けた人が担当のままの課題も、取りこぼさないよう列にする
    const me = this.myUid;
    const members = this.ctx.members().filter((m) => m.role !== 'viewer')
      .sort((a, b) => Number(b.uid === me) - Number(a.uid === me) || a.displayName.localeCompare(b.displayName))
      .map((m) => m.uid);
    const ids = [...new Set([...members, ...list.map((i) => i.assigneeId)])];
    return ids.map((uid) => {
      const issues = sorted(list.filter((i) => i.assigneeId === uid));
      return {
        key: uid,
        label: this.memberName(uid) + (uid === me ? this.i18n.t('issueNew.you') : ''),
        issues, overdue: issues.filter((i) => this.isOverdue(i)).length,
      };
    });
  });

  /** スマホの列の切り替えボタン（今の分け方の列） */
  tabCols = computed(() => this.by() === 'status'
    ? this.mobileCols.map((c) => ({ key: c as string, label: this.i18n.t('board.cols.' + c), n: this.byCol()[c].length }))
    : this.altCols().map((c) => ({ key: c.key, label: c.label, n: c.issues.length })));

  /** 期限の列：見る人のタイムゾーンの暦で、今日・明日。それ以降は、7日以内かどうか */
  private dueCol(i: Issue, now: number): DueCol {
    const b = dueBucket(i.dueAt.toMillis(), now, this.tz());
    if (b === 'overdue' || b === 'today' || b === 'tomorrow') return b;
    return i.dueAt.toMillis() - now <= 7 * DAY ? 'week' : 'later';
  }
  
  /** 期限を変えられるか：管理者・提起者・担当者で、クローズ前（ルールの editAllowed・カレンダーと同じ） */
  canMoveDue(i: Issue) {
    if (i.status === 'closed' || this.ctx.archived()) return false;
    const r = this.ctx.role();
    return r === 'admin' || (r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid));
  }

  /**
   * 期限の列に落としたら、窓で理由を書いて確定する（元に戻すも窓が出す）。
   * 今日・明日は日が決まる。1週間以内・それより先は、窓で日を選ぶ（最初の値と、選べる範囲を渡す）
   */
  onDueDrop(e: CdkDragDrop<string, string, Issue>) {
    this.dragging.set(null);
    if (e.previousContainer === e.container) return;
    const tz = this.tz();
    const day = (n: number) => dateKey(endOfDayIn(n, tz), tz);
    const col = e.container.data as DueCol;
    const plan: Partial<Record<DueCol, { date: string; pick: { min: string; max: string | null } | null }>> = {
      today: { date: day(0), pick: null },
      tomorrow: { date: day(1), pick: null },
      week: { date: day(7), pick: { min: day(2), max: day(7) } },
      later: { date: day(14), pick: { min: day(8), max: null } },
    };
    const p = plan[col];
    if (p) this.pendingDue.set({ issue: e.item.data, ...p });
  }

  /** ドラッグ中のカードを、その列に落とせるか（CDKに渡す判定） */
  readonly predicates: Record<ColKey, (drag: CdkDrag<Issue>) => boolean> = {
    open: (d) => this.canMove(d.data, 'open'),
    in_progress: (d) => this.canMove(d.data, 'in_progress'),
    resolved: (d) => this.canMove(d.data, 'resolved'),
    done: (d) => this.canMove(d.data, 'done'),
    on_hold: (d) => this.canMove(d.data, 'on_hold'),
  };

  constructor() {
    // 画面を描き直すたびに、本体の横の長さを測り直す（カードの増減・表示の切り替え・窓の大きさの変化に追いつくため）。
    // 値が変わったときだけ入れるので、描き直しが続けて起きることはない
    afterEveryRender(() => {
      const el = this.boardEl()?.nativeElement;
      if (!el) return;
      const w = el.scrollWidth;
      const over = w > el.clientWidth + 1;
      if (w !== this.scrollWidth()) this.scrollWidth.set(w);
      if (over !== this.overflowing()) this.overflowing.set(over);
    });
    const onChange = (e: MediaQueryListEvent) => this.isMobile.set(e.matches);
    this.mq.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => {
      this.mq.removeEventListener('change', onChange);
      this.stopClosed?.();
      clearTimeout(this.noticeTimer);
      cancelAnimationFrame(this.raf);
    });
  }

  async ngOnInit() {
    const p = this.route.snapshot.queryParamMap;
    this.mine.set(p.get('mine') === '1');
    const d = p.get('due');
    this.due.set(d === 'today' || d === 'week' || d === 'overdue' ? d : null);
    const b = p.get('by');
    this.by.set(b === 'due' || b === 'assignee' ? b : 'status');
    this.mobileCol.set(this.tabCols()[0]?.key ?? 'open');
    this.watchClosed();
  }


  /** 直近7日のクローズを見張る（未クローズは置き場の見張りから） */
  private watchClosed() {
    this.stopClosed = this.issueService.watchRecentlyClosed(
      this.ctx.pid(), 7,
      (issues) => {
        this.recentClosed.set(issues);
        this.closedLoading.set(false);
      },
      (e) => {
        console.error(e);
        this.closedLoading.set(false);
      },
    );
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
  /** 列の分け方を変える（スマホでは、最初の列に戻る） */
  setBy(v: ViewBy) {
    this.by.set(v);
    // 期限の絞り込みは、「期限」の表示では見えなくなるので外す（見えない条件で絞られたままにしない）
    if (v === 'due') this.due.set(null);
    this.menuFor.set(null);
    this.mobileCol.set(this.tabCols()[0]?.key ?? 'open');
    this.boardEl()?.nativeElement.scrollTo({ left: 0 });
    this.updateUrl();
  }
  private updateUrl() {
    this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParamsHandling: 'merge',
      queryParams: { mine: this.mine() ? '1' : null, due: this.due(), by: this.by() === 'status' ? null : this.by() },
    });
  }

  // ---- 移動 ----
  /** その人がこの課題でできる移動（却下はかんばんでは扱わない） */
  moves(i: Issue) {
    const role = this.ctx.role();
    if (!role || this.ctx.archived()) return [];
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
  onDragStart(i: Issue) {
    this.frozen.set(this.issues()); // この時点の並びで止める
    this.dragging.set(i);
    this.raf = requestAnimationFrame(this.autoScroll);
  }

  onDragEnd() {
    this.dragging.set(null);
    this.frozen.set(null); // 止めていた間に届いた変更を、ここで反映する
    cancelAnimationFrame(this.raf);
    this.pointer = null;
  }

  // ---- ドラッグ中の自動スクロール ----
  /** ドラッグ中の、指（マウス）の位置 */
  private pointer: { x: number; y: number } | null = null;
  private raf = 0;

  onDragMoved(e: CdkDragMove<Issue>) {
    this.pointer = e.pointerPosition;
  }

  /**
   * 端に近いほど速く流す。かんばんの箱の外へ出ても、止めずに最高速で流し続ける
   * （CDK の自動スクロールは、箱の外へ出ると止まるため、自分たちで流す）。縦は、画面の上下の端でページを流す
   */
  private autoScroll = () => {
    const el = this.boardEl()?.nativeElement;
    const p = this.pointer;
    if (el && p) {
      const zone = 80;   // 端からこの幅に入ったら流し始める
      const max = 18;    // 1回（約1/60秒）に流す最大の幅
      const speed = (d: number) => Math.min(1, d / zone) * max;
      const r = el.getBoundingClientRect();
      if (p.x > r.right - zone) el.scrollLeft += speed(p.x - (r.right - zone));
      else if (p.x < r.left + zone) el.scrollLeft -= speed(r.left + zone - p.x);
      const h = window.innerHeight;
      if (p.y > h - zone) window.scrollBy(0, speed(p.y - (h - zone)));
      else if (p.y < zone) window.scrollBy(0, -speed(zone - p.y));
    }
    this.raf = requestAnimationFrame(this.autoScroll);
  };
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
      if (UNDO_OF[t.key]) {
        this.undo.offer('undo.moved', { n: String(issue.number), to: this.i18n.t('status.' + t.to) },
          () => this.issueService.undoStatus(this.ctx.pid(), issue, t, this.myUid, this.tz()));
      }
    } catch (e) {
      if (e instanceof ConflictError) this.showNotMoved(issue, e.latest);
      else console.error(e);
    }
  }

  /** 先に更新されていて動かせなかったことを、6秒だけ知らせる */
  private showNotMoved(issue: Issue, latest: Issue) {
    this.notMoved.set({ n: issue.number, latest });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notMoved.set(null), 6000);
  }

  who(latest: Issue) {
    return conflictWho(latest, this.ctx.members(), this.myUid);
  }

  async onDialogDone() {
    this.pending.set(null);
  }

  // ---- 表示用 ----
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  /** 停滞とみなす日数（プロジェクトの設定。なければ既定の7日） */
  staleDays = computed(() => this.ctx.project()?.settings?.staleDays ?? DEFAULT_SETTINGS.staleDays);
  stale(i: Issue) {
    return isStale(i, this.staleDays(), this.clock.now());
  }
  wa(i: Issue) {
    return hasWorkaround(i);
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }
  memberName(uid: string) {
    return this.ctx.nameOf(uid);
  }
  memberPhoto(uid: string) {
    return this.ctx.members().find((m) => m.uid === uid)?.photoURL ?? null;
  }
  // ---- スマホ：なでて列を移る ----
  /** 画面の真ん中に一番近い列を、今の列にする */
  onBoardScroll() {
    const el = this.boardEl()?.nativeElement;
    const top = this.topScroll()?.nativeElement;
    if (el && top && !this.syncing && Math.abs(top.scrollLeft - el.scrollLeft) >= 1) {
      this.syncing = true;
      top.scrollLeft = el.scrollLeft;
      requestAnimationFrame(() => (this.syncing = false));
    }
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
    const key = this.tabCols()[best]?.key;
    if (key && key !== this.mobileCol()) this.mobileCol.set(key);
  }

  /** 上のバーを動かしたら、本体もついてくる */
  onTopScroll() {
    const el = this.boardEl()?.nativeElement;
    const top = this.topScroll()?.nativeElement;
    // ドラッグ中は、本体の自動スクロールに任せる（上のバーが1拍前の位置へ引き戻さないように）。
    // 位置がもうそろっていれば、何もしない
    if (!el || !top || this.syncing || this.dragging() || Math.abs(el.scrollLeft - top.scrollLeft) < 1) return;
    this.syncing = true;
    el.scrollLeft = top.scrollLeft;
    requestAnimationFrame(() => (this.syncing = false));
  }

  /** 列名のボタンを押したら、その列までスクロールする */
  scrollToCol(c: string) {
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