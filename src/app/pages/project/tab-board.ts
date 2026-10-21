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
import {
  DEFAULT_SETTINGS, InboxMemo, Issue, IssueStatus, Level, MAX_SUBTASKS, Subtask, labelsOf, hasWorkaround,
} from '../../core/models';
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
import { PeopleFilter, whoFromQuery, whoQuery } from '../../shared/people-filter';
import { Avatar } from '../../shared/avatar';
import { TrashDrop } from '../../shared/trash-drop';
import { DeleteDialog } from '../issue/delete-dialog';
import { AssigneeDialog } from '../../shared/assignee-dialog';
import { InboxService } from '../../core/inbox/inbox.service';
import { IssueFormService } from '../../core/issue/issue-form.service';
import { ChipMenu } from '../../shared/chip-menu';

type ColKey = 'open' | 'in_progress' | 'resolved' | 'done' | 'on_hold';
type DueFilter = 'today' | 'week' | 'overdue';
/** 列の分け方（カタログ【5】）。ドラッグはステータス別のときだけ（赤AJ） */
type ViewBy = 'status' | 'due' | 'assignee';
type DueCol = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';
/** 期限別・担当者別の列（見るだけ） */
interface AltCol { key: string; label: string; issues: Issue[]; overdue: number; }
/** 期限の列 → その列の期限（今日から何日後の 23:59）。ドラッグで落としたときの最初の値と、「＋」で登録するときの期限 */
const DUE_COL_DAYS: Record<string, number> = { today: 0, tomorrow: 1, week: 7, later: 14 };
const DAY = 24 * 60 * 60 * 1000;
/** つかんでいるのが受信箱のメモか（課題には番号があり、メモにはない） */
function isMemo(x: unknown): x is InboxMemo {
  return !!x && typeof x === 'object' && !('number' in x);
}

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
    CdkScrollable, RouterLink, TPipe, HelpTip, StatusDialog, LabelChip, PriorityMark, DueDialog, PeopleFilter,
    Avatar, TrashDrop, DeleteDialog, AssigneeDialog, ChipMenu],
    host: { '(window:resize)': 'measure()' },
  template: `
    <div class="quick">
      <app-people-filter [members]="ctx.assignable()" [counts]="ctx.activeCount()" [value]="who()"
        (picked)="setWho($event)" />
      @if (!isMobile() && ctx.canCreate() && !ctx.archived()) {
        <div class="chips">
          <button type="button" [class.on]="inboxOpen()" [attr.aria-pressed]="inboxOpen()" (click)="toggleInbox()">
            {{ 'inbox.title' | t }} {{ inbox.count() }}</button>
        </div>
      }
      <app-chip-menu [label]="'board.byLabel' | t" [options]="byMenu()" [value]="by()" (picked)="setBy($any($event))" />
      <!-- 「期限」の表示では、列そのものが期限で分かれているので出さない -->
      @if (by() !== 'due') {
        <app-chip-menu [label]="'issue.due' | t" [options]="dueMenu()" [value]="due() ?? 'all'" [active]="!!due()"
          (picked)="pickDue($event)" />
      }
      @if (!isMobile()) {
        <app-chip-menu [label]="'board.colsLabel' | t" [options]="colsMenu()" [value]="colsPick()"
          (picked)="setCols(+$event)" />
      }
      @if (by() === 'assignee') {
        <span class="view-note">{{ 'board.assigneeDropHint' | t }}</span>
      } @else if (by() === 'due') {
        <span class="view-note">{{ 'board.dueDropHint' | t }}</span>
      } @else if (ctx.role() === 'viewer') {
        <app-help-tip kind="denied" align="right" [keys]="['board.viewerCannotMove']" />
      }
    </div>

    @if (notMoved(); as m) {
      @let w = conflictBy(m.latest);
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

      <div class="board-wrap" cdkDropListGroup>
      @if (showInbox()) {
        <!-- 受信箱の帯：横に流れない。メモを列に落とすと、登録の窓が開く -->
        <aside class="inbox-strip" [style.height.px]="boardH()">
          <header class="col-head">
            <a routerLink="/inbox" class="col-name strip-link">{{ 'inbox.title' | t }} ›</a>
            <span class="count">{{ inbox.count() }}</span>
          </header>
          <div class="cards" cdkDropList [cdkDropListData]="'inbox'" [cdkDropListSortingDisabled]="true"
            [cdkDropListEnterPredicate]="noEnter">
            @for (m of inbox.active(); track m.id) {
              <article class="card memo" cdkDrag [cdkDragData]="m" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                (cdkDragStarted)="onMemoDragStart(m)" (cdkDragEnded)="onMemoDragEnd(m)" (cdkDragMoved)="onDragMoved($event)">
                <div class="body">
                  <span class="title">{{ m.title }}</span>
                  @if (m.body) { <span class="memo-b">{{ firstLine(m.body) }}</span> }
                  @if (inbox.isOld(m)) { <span class="old">{{ 'inbox.old' | t }}</span> }
                </div>
              </article>
            } @empty {
              <p class="empty">{{ 'inbox.empty' | t }}</p>
            }
          </div>
        </aside>
      }
      <div class="board-area">
      @if (by() === 'status') {
        <div class="board" #boardEl cdkScrollable [class.dragging]="!!dragging()"
          [style.height.px]="boardH()" (scroll)="onBoardScroll()">
          @for (c of visibleCols(); track c) {
            <section class="col" [attr.data-col]="c" [style.flex]="colFlex()"
              [class.allowed]="anyDrag() && canDropInto(c)" [class.blocked]="anyDrag() && !canDropInto(c)">
              <header class="col-head">
                <span class="col-name">{{ 'board.cols.' + c | t }}</span>
                <span class="count">{{ byCol()[c].length }}</span>
                @if (c === 'open' && ctx.canCreate()) {
                  <button type="button" class="head-add" (click)="issueForm.open(ctx.pid())"
                    [attr.aria-label]="'project.newIssue' | t" [title]="'project.newIssue' | t">＋</button>
                }
                @if (c === 'done') { <span class="note">{{ 'board.doneNote' | t }}</span> }
              </header>
                <div class="cards" cdkDropList [cdkDropListData]="c" [cdkDropListEnterPredicate]="predicates[c]"
                  [cdkDropListSortingDisabled]="!!draggingMemo()"
                  [cdkDropListAutoScrollDisabled]="true" (cdkDropListDropped)="onDrop($event)">
                  @if (draggingMemo() && c === 'open') { <p class="drop-hint">{{ 'board.dropToIssue' | t }}</p> }
                  @for (i of byCol()[c]; track i.id) {
                    <article class="card" [attr.data-iid]="i.id" [class.target]="hoverCard()?.id === i.id"
                      cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canDrag(i)" (cdkDragMoved)="onDragMoved($event)"
                      [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                      (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnd()"
                      [attr.data-p]="isActive(i) ? prio(i) : null" [class.closed]="i.status === 'closed'">
                      <ng-container [ngTemplateOutlet]="cardBody" [ngTemplateOutletContext]="{ $implicit: i }" />
                    </article>
                  } @empty {
                    <p class="empty">{{ 'board.empty' | t }}</p>
                  }
                </div>
            </section>
          }
          @if (canTrash()) { <app-trash-drop [show]="anyDrag()" (dropped)="onTrash($event)" /> }
        </div>
      } @else {
        <!-- 期限別：期限の列へドラッグできる（落とすと期限の変更の窓）。担当者別：見るだけ -->
        <div class="board" #boardEl cdkScrollable [class.dragging]="!!dragging()"
          [style.height.px]="boardH()" (scroll)="onBoardScroll()">
          @for (c of altCols(); track c.key) {
            <section class="col" [attr.data-col]="c.key" [style.flex]="colFlex()"
              [class.allowed]="anyDrag() && altOk(c.key)" [class.blocked]="anyDrag() && !altOk(c.key)">
              <header class="col-head">
                <span class="col-name">{{ c.label }}</span>
                <span class="count">{{ c.issues.length }}</span>
                @if (c.overdue) { <span class="od">{{ 'board.overdueN' | t: { n: '' + c.overdue } }}</span> }
                @if (by() === 'due' && c.key !== 'overdue' && ctx.canCreate()) {
                  <button type="button" class="head-add hover" (click)="issueForm.open(ctx.pid(), { due: dueDateOf(c.key) })"
                    [attr.aria-label]="'project.newIssue' | t" [title]="'project.newIssue' | t">＋</button>
                }
              </header>
              <div class="cards" cdkDropList [cdkDropListData]="c.key"
                [cdkDropListSortingDisabled]="true" [cdkDropListEnterPredicate]="altEnter"
                [cdkDropListAutoScrollDisabled]="true" (cdkDropListDropped)="onDueDrop($event)">
                @if (draggingMemo() && altOk(c.key)) { <p class="drop-hint">{{ 'board.dropToIssue' | t }}</p> }
                @for (i of c.issues; track i.id) {
                  @let movable = canMoveDue(i);
                  <article class="card" [attr.data-iid]="i.id" [class.target]="hoverCard()?.id === i.id"
                    [class.static]="!movable" [attr.data-p]="prio(i)" (cdkDragMoved)="onDragMoved($event)"
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
          @if (canTrash()) { <app-trash-drop [show]="anyDrag()" (dropped)="onTrash($event)" /> }
        </div>
      }
        <!-- 列の数を選んでいるとき：左右の端に、1列ずつ送るボタン（乗せると薄く出る） -->
        @if (colsPick() && !isMobile() && !anyDrag()) {
          @if (canLeft()) {
            <button type="button" class="pager left" [attr.aria-label]="'board.prevCol' | t" [title]="'board.prevCol' | t"
              (click)="page(-1)">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg></button>
          }
          @if (canRight()) {
            <button type="button" class="pager right" [attr.aria-label]="'board.nextCol' | t" [title]="'board.nextCol' | t"
              (click)="page(1)">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg></button>
          }
        }
      </div>
      </div>
    }

    <!-- カードの中身（3つの表示で共通） -->
    <ng-template #cardBody let-i>
      @if (hoverCard()?.id === i.id) { <div class="sub-hint">{{ 'board.toSubtask' | t }}</div> }
      @if (isOverdue(i)) { <div class="band">{{ 'board.overdue' | t }}</div> }
      <div class="body">
        <div class="top">
          <span class="id">
            @if (isActive(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> }
            <span class="num">#{{ i.number }}</span>
            @if (i.recurringId) {
              <span class="recur" [title]="'recurring.badge' | t" role="img" [attr.aria-label]="'recurring.badge' | t">
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m17 2 4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" />
                  <path d="m7 22-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></svg></span>
            }
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
          <span [title]="memberName(i.assigneeId)">
            <app-avatar [name]="memberName(i.assigneeId)" [uid]="i.assigneeId" [photo]="memberPhoto(i.assigneeId)" [size]="24" />
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
        [effort]="!!ctx.project()?.settings?.features?.effort"
        (done)="onDialogDone()" (cancel)="pending.set(null)" />
    }
    @if (pendingDue(); as p) {
      <app-due-dialog [issue]="p.issue" [date]="p.date" [pickDate]="p.pick" [pid]="ctx.pid()" [members]="ctx.members()"
        (done)="pendingDue.set(null)" (cancel)="pendingDue.set(null)" />
    }
    @if (pendingAssignee(); as p) {
      <app-assignee-dialog [pid]="ctx.pid()" [issue]="p.issue" [to]="p.to" [members]="ctx.members()" [nameOf]="nameFn"
        (done)="pendingAssignee.set(null)" (cancel)="pendingAssignee.set(null)" />
    }
    @if (deleting(); as d) {
      <app-delete-dialog [pid]="ctx.pid()" [issue]="d" [members]="ctx.members()"
        (done)="onDeleted(d)" (cancel)="deleting.set(null)" />
    }
  `,
  styles: `
    .quick { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin-bottom: 12px; }
    .notice { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }

    /* 箱は窓の下の端まで（高さは画面が測って入れる）。縦は列の中だけで流れ、横のバーはいつも窓の下に見える */
    .board { position: relative; box-sizing: border-box; display: flex; gap: 12px; align-items: flex-start;
      overflow-x: auto; overflow-y: hidden; padding-bottom: 8px; }
    .col { flex: 1 1 0; min-width: 220px; max-height: 100%; min-height: 0; box-sizing: border-box;
      background: var(--surface-alt); border-radius: 10px;
      border-top: 4px solid var(--disabled); display: flex; flex-direction: column; }
    .col[data-col='in_progress'] { border-top-color: var(--primary); }
    .col[data-col='resolved'] { border-top-color: var(--success); }
    .col[data-col='done'] { border-top-color: var(--text-muted); }
    .col[data-col='on_hold'] { border-top-color: var(--warning); }
    .col.allowed { outline: 2px dashed var(--primary); outline-offset: -2px; }
    .col.blocked { opacity: 0.45; }
    .col-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; font-weight: bold; font-size: 14px; }
    .count { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface); }
    .note { font-size: 11px; font-weight: normal; color: var(--text-subtle); flex-basis: 100%; }

    .cards { flex: 1 1 auto; min-height: 40px; overflow-y: auto; display: flex; flex-direction: column;
      gap: 8px; padding: 0 8px 8px; }
    /* カードは縮ませない（overflow: hidden のカードは 0 まで縮められてしまう。はみ出した分は列の中でスクロール） */
    .cards > * { flex: none; }
    /* 左に受信箱の帯（横に流れない）、右にかんばん（送りボタンは、かんばんの場所の左右の端） */
    .board-wrap { display: flex; gap: 12px; align-items: flex-start; }
    .board-area { position: relative; flex: 1; min-width: 0; }
    .inbox-strip { flex: none; width: 240px; box-sizing: border-box; display: flex; flex-direction: column;
      background: var(--surface-alt); border-radius: 10px; border-top: 4px solid var(--primary); }
    .strip-link { color: var(--text); text-decoration: none; }
    .strip-link:hover { text-decoration: underline; }
    .card.memo { border-left-color: var(--primary); }
    /* メモを重ねている課題のカード */
    .card.target { outline: 3px solid var(--primary); outline-offset: -1px; background: var(--primary-bg); }
    .sub-hint { padding: 2px 10px; font-size: 11px; font-weight: bold; background: var(--primary); color: var(--on-primary); }
    .drop-hint { margin: 0; padding: 10px; border: 2px dashed var(--primary); border-radius: 8px;
      background: var(--primary-bg); color: var(--primary); font-size: 12px; font-weight: bold; text-align: center; }
    /* つかんだメモの元の場所（影）は出さない。ほかの列に入ったときに、カードを押し下げないように */
    .card.memo.cdk-drag-placeholder { display: none; }
    /* 影が無いので、離したときに絵をすべらせて戻さない（戻る先が画面の左上になってしまうため） */
    .card.memo.cdk-drag-animating { transition: none; }
    .memo-b { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .old { align-self: flex-start; font-size: 11px; padding: 1px 6px; border-radius: 8px;
      background: var(--warning-bg); color: var(--warning-text); }
    .pager { position: absolute; top: 50%; transform: translateY(-50%); z-index: 5; width: 36px; height: 56px;
      display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text-muted);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); opacity: 0; transition: opacity 0.15s; cursor: pointer; }
    .pager.left { left: 4px; }
    .pager.right { right: 4px; }
    .board-area:hover .pager { opacity: 0.75; }
    .pager:hover, .pager:focus-visible { opacity: 1 !important; color: var(--text); }
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
    .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .moves { display: flex; flex-wrap: wrap; gap: 6px; border-top: 1px solid var(--border); padding-top: 6px; }
    .moves button { min-height: 40px; padding: 0 12px; border: 1px solid var(--primary); color: var(--primary);
      background: var(--surface); border-radius: 8px; font-size: 13px; }
    .empty { font-size: 12px; color: var(--text-subtle); text-align: center; margin: 8px 0; }
    .head-add { margin-left: auto; width: 32px; height: 32px; border-radius: 8px; display: inline-flex;
      align-items: center; justify-content: center; color: var(--primary); text-decoration: none;
      font-size: 18px; font-weight: bold; }
    button.head-add { padding: 0; border: none; background: none; cursor: pointer; }
    .head-add:hover { background: var(--surface); }
        /* 期限の列の ＋ は、マウスの端末では列に乗せたときだけ出す（スマホはいつも出す） */
    @media (hover: hover) and (pointer: fine) {
      .head-add.hover { opacity: 0; }
      .col:hover .head-add.hover, .head-add.hover:focus-visible { opacity: 1; }
    }

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
    .stale { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--warning-bg); color: var(--warning-text); }
    .wa { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--hold-bg); }
    .subs { align-self: flex-start; font-size: 12px; color: var(--text-muted); }
    .subs.all { color: var(--success-text); font-weight: bold; }    
    .recur { display: inline-flex; color: var(--text-muted); }
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
  /** スマホで今見ている列（ステータス・期限・担当者の、どの列の名前でも入る） */
  mobileCol = signal<string>('open');
  readonly views: ViewBy[] = ['status', 'due', 'assignee'];
  by = signal<ViewBy>('status');
  dragging = signal<Issue | null>(null);
  pending = signal<{ issue: Issue; t: Transition } | null>(null);
  /** 期限のかんばんで落としたあと、窓で確かめ中の変更（pick があれば、窓で日付も選ぶ） */
  pendingDue = signal<{ issue: Issue; date: string; pick: { min: string; max: string | null } | null } | null>(null);
  /** 期限・担当者のかんばんで、落とせる列か（CDK に渡す判定。枠の色も同じ判定を使う） */
  readonly altEnter = (_drag: CdkDrag<Issue>, drop: CdkDropList<string>) => this.altOk(drop.data);
  /**
   * 期限：期限切れの列には落とせない（わざわざ過去にする場面がないため。どうしても過去にするなら、詳細から）。
   * 担当者：担当者になれる人（管理者・メンバー）の列だけ。抜けた人の列には落とせない（ルールでも断られるため）
   */
  altOk(key: string) {
    return this.by() === 'due' ? key !== 'overdue' : this.ctx.assignable().some((m) => m.uid === key);
  }
  /** 担当者のかんばんで落としたあと、窓で確かめ中の変更 */
  pendingAssignee = signal<{ issue: Issue; to: string } | null>(null);
  /** 窓に渡す名前の引き方（テンプレートでは矢印関数が書けないので、ここで作る） */
  readonly nameFn = (uid: string) => this.ctx.nameOf(uid);
  protected inbox = inject(InboxService);
  protected issueForm = inject(IssueFormService);
  /** 受信箱のメモをつかんでいる間 */
  draggingMemo = signal<InboxMemo | null>(null);
  /** 課題かメモのどちらかを、つかんでいるか */
  anyDrag = computed(() => !!this.dragging() || !!this.draggingMemo());
  /** 帯の中には、何も落とさせない（メモはかんばんの列へ。課題は帯に入れない） */
  readonly noEnter = () => false;

  /** 受信箱の帯を開いているか（端末ごとに覚える） */
  private readonly inboxKey = `issuemanager.boardInbox.${auth.currentUser!.uid}`;
  inboxOpen = signal((() => {
    try {
      return localStorage.getItem(this.inboxKey) === '1';
    } catch {
      return false;
    }
  })());
  /** 帯を出すか：PC で、課題を作れる人（管理者・メンバー）が開いたとき。アーカイブ中は出さない */
  showInbox = computed(() => this.inboxOpen() && !this.isMobile() && this.ctx.canCreate() && !this.ctx.archived());

  toggleInbox() {
    this.inboxOpen.set(!this.inboxOpen());
    try {
      localStorage.setItem(this.inboxKey, this.inboxOpen() ? '1' : '0');
    } catch {
      // 覚えられなくても、今の画面には効く
    }
  }

  firstLine(body: string) {
    return body.split('\n')[0];
  }

  /** メモを重ねている課題（光らせる。離したら、この課題のサブタスクにする） */
  hoverCard = signal<Issue | null>(null);
  /** カードに重ねて使ったメモ（列に落ちたほうの処理を、二重に動かさないための目印） */
  private consumed: string | null = null;

  onMemoDragStart(m: InboxMemo) {
    this.consumed = null;
    this.draggingMemo.set(m);
    this.raf = requestAnimationFrame(this.autoScroll);
  }

  /** 離したとき：カードが光っていれば、その課題のサブタスクにする */
  onMemoDragEnd(m: InboxMemo) {
    this.clearDwell();
    const target = this.hoverCard();
    this.hoverCard.set(null);
    this.onDragEnd();
    if (!target) return;
    this.consumed = m.id;
    this.memoToSubtask(m, target);
  }

  /**
   * 受信箱のメモを重ねて、サブタスクにできる課題か。
   * サブタスクのルール（canEditParent）と同じ：管理者・提起者・担当者で、クローズ・統合・削除・アーカイブ中は不可。30件まで
   */
  canSubtask(i: Issue) {
    const r = this.ctx.role();
    if (this.ctx.archived() || (r !== 'admin' && r !== 'member')) return false;
    if (['closed', 'deleted', 'merged'].includes(i.status)) return false;
    if (r !== 'admin' && i.reporterId !== this.myUid && i.assigneeId !== this.myUid) return false;
    return (i.subtaskTotal ?? 0) < MAX_SUBTASKS;
  }

  /** 指の下のカードを確かめる（CDK のつかんだ絵は、指の下の判定に入らないので、その下のカードが見える） */
  /** 光るのを待っているカード（0.5秒止まったら光らせる） */
  private dwell: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  private clearDwell() {
    if (this.dwell) clearTimeout(this.dwell.timer);
    this.dwell = null;
  }

  /**
   * 指の下のカードを確かめる。カードの上で 0.5秒止まったら光らせる（通り過ぎるだけでは光らない）。
   * 光っているカードから外れたら、すぐ消す
   */
  private findTarget(p: { x: number; y: number }) {
    const el = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('[data-iid]');
    const i = el ? this.issues().find((x) => x.id === el.dataset['iid']) ?? null : null;
    const t = i && this.canSubtask(i) ? i : null;
    if (t && t.id === this.hoverCard()?.id) return;          // 光っているカードの上にいる
    if (this.hoverCard()) this.hoverCard.set(null);          // 光っているカードから外れた
    if (!t) {
      this.clearDwell();
      return;
    }
    if (this.dwell?.id === t.id) return;                     // このカードで待っている途中
    this.clearDwell();
    this.dwell = { id: t.id, timer: setTimeout(() => {
      this.dwell = null;
      this.hoverCard.set(t);
    }, 300) };
  }

  /**
   * メモを、課題のサブタスクにする。タイトル＝メモのタイトル、メモ＝本文、担当者＝課題の担当者、期限なし。
   * メモはゴミ箱へ。「元に戻す」は、サブタスクを消してメモを戻す
   */
  private async memoToSubtask(m: InboxMemo, i: Issue) {
    const pid = this.ctx.pid();
    try {
      const subs = await this.issueService.listSubtasks(pid, i.id);
      if (subs.length >= MAX_SUBTASKS) return;
      const assigneeId = this.ctx.assignable().some((x) => x.uid === i.assigneeId) ? i.assigneeId : this.myUid;
      const order = subs.reduce((mx, s) => Math.max(mx, s.order), 0) + 1;
      const sid = await this.issueService.addSubtask(pid, i,
        { title: m.title, assigneeId, dueAt: null, order, memo: m.body.slice(0, 2000) }, this.myUid, this.tz());
      await this.inbox.discard(m.id);
      this.undo.offer('board.toSubtaskDone', { n: String(i.number) }, async () => {
        await this.issueService.deleteSubtask(pid, i.id, { id: sid, title: m.title } as Subtask, this.myUid, this.tz());
        await this.inbox.restore(m.id);
      });
    } catch (e) {
      console.error(e);
    }
  }

  /** ゴミ箱に落とした：課題なら削除の窓、メモならゴミ箱へ（元に戻すつき） */
  async onTrash(x: Issue | InboxMemo) {
    if (!isMemo(x)) {
      this.deleting.set(x);
      return;
    }
    try {
      await this.inbox.discard(x.id);
      this.undo.offer('inbox.discarded', undefined, () => this.inbox.restore(x.id));
    } catch (e) {
      console.error(e);
    }
  }
  menuFor = signal<string | null>(null);
  /** ゴミ箱に落とした課題（削除の窓で確かめ中） */
  deleting = signal<Issue | null>(null);
  /** ゴミ箱を出すか：削除できるのは管理者だけ。アーカイブ中は出さない */
  canTrash = computed(() => this.ctx.role() === 'admin' && !this.ctx.archived());
  /** URL から読んだ「選んだ人」（抜けた人が混ざっていることもある） */
  private whoRaw = signal<string[]>([]);
  /** 絞り込みに使う人。担当者になれる人だけ残す（抜けた人は黙って外す。だれも残らなければ全員） */
  who = computed(() => {
    const ok = new Set(this.ctx.assignable().map((m) => m.uid));
    return this.whoRaw().filter((u) => ok.has(u));
  });
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
  /** かんばんの箱の高さ（窓の下の端まで。描くたび・窓の大きさが変わるたびに測る） */
  boardH = signal<number | null>(null);
  /** 表示する列の数（0＝全部）。画面の大きさで向く数が違うので、端末ごとに覚える */
  private readonly colsKey = `issuemanager.boardCols.${auth.currentUser!.uid}`;
  readonly colsOptions = [0, 1, 2, 3, 4];
  colsPick = signal<number>((() => {
    try {
      const n = Number(localStorage.getItem(this.colsKey));
      return [1, 2, 3, 4].includes(n) ? n : 0;
    } catch {
      return 0;
    }
  })());
  /** プルダウンの中身（言語を切り替えても、すぐ言葉が変わるように computed で） */
  byMenu = computed(() => this.views.map((v) => ({ value: v, label: this.i18n.t('board.views.' + v) })));
  dueMenu = computed(() => [
    { value: 'all', label: this.i18n.t('board.dueAll') },
    ...this.dueOptions.map((d) => ({ value: d, label: this.i18n.t('board.due.' + d) })),
  ]);
  colsMenu = computed(() => this.colsOptions.map((n) => ({
    value: n, label: n ? this.i18n.t('board.colsN', { n: String(n) }) : this.i18n.t('board.colsAll'),
  })));
  /** 列の幅：選んだ数で箱を割る。列がそれより少ないときは、ある列の数で割る（右に空きを残さない） */
  colFlex = computed(() => {
    const pick = this.colsPick();
    if (!pick || this.isMobile()) return null;
    const total = this.by() === 'status' ? this.visibleCols().length : this.altCols().length;
    const n = Math.max(1, Math.min(pick, total));
    return `0 0 calc((100% - ${(n - 1) * 12}px) / ${n})`;
  });

  setCols(n: number) {
    this.colsPick.set(n);
    try {
      localStorage.setItem(this.colsKey, String(n));
    } catch {
      // 覚えられなくても、今の画面には効く
    }
  }

  /**
   * 箱の高さ ＝ 窓の高さ − 箱の上の端（ページの頭から）− 下の余白（main の 16px）。
   * 小さすぎる窓では 320px を下限にする（そのときだけページが縦に流れる）
   */
  measure() {
    const el = this.boardEl()?.nativeElement;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(320, Math.floor(window.innerHeight - top - 16));
    if (h !== this.boardH()) this.boardH.set(h);
    this.edges();
  }

  /** 左・右に、まだ送れる列があるか（端まで来た側のボタンは出さない） */
  canLeft = signal(false);
  canRight = signal(false);

  private edges() {
    const el = this.boardEl()?.nativeElement;
    if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    if (l !== this.canLeft()) this.canLeft.set(l);
    if (r !== this.canRight()) this.canRight.set(r);
  }

  /** 1列分送る。今いる位置を列の幅で数え直してから送るので、半端な位置からでも列の頭にそろって止まる */
  page(dir: 1 | -1) {
    const el = this.boardEl()?.nativeElement;
    const first = el?.querySelector<HTMLElement>('.col');
    if (!el || !first) return;
    const step = first.offsetWidth + 12; // 列の幅 ＋ すき間
    const idx = Math.round(el.scrollLeft / step) + dir;
    el.scrollTo({ left: Math.max(0, idx * step), behavior: 'smooth' });
  }

  /** すばやい絞り込みをかけた課題 */
  filtered = computed(() => {
    const now = this.clock.now();
    let list = this.issues();
    const who = new Set(this.who());
    if (who.size) list = list.filter((i) => who.has(i.assigneeId));
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
    // 人を選んでいるときは、選んだ人の列だけ
    const who = this.who();
    const members = this.ctx.assignable().filter((m) => !who.length || who.includes(m.uid))
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

  /** 今の画面の道（登録画面から、このかんばんに戻ってくるため。分け方・人の絞り込みも入っている） */
  here() {
    return this.router.url;
  }

  /** 期限の列の「＋」で登録するときの期限の日（見る人のタイムゾーンの暦で） */
  dueDateOf(col: string) {
    const tz = this.tz();
    return dateKey(endOfDayIn(DUE_COL_DAYS[col] ?? 0, tz), tz);
  }

  /** 期限・担当者を変えられるか：管理者・提起者・担当者で、クローズ前（ルールの editAllowed・カレンダーと同じ） */
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
    if (e.previousContainer === e.container || !e.isPointerOverContainer) return;
    // 受信箱のメモ：その列の期限か担当者を入れて、登録の窓を開く
    const data = e.item.data as Issue | InboxMemo;
    if (isMemo(data)) {
      if (this.consumed === data.id || this.hoverCard()) return;
      const key = e.container.data;
      if (this.altOk(key)) {
        this.issueForm.open(this.ctx.pid(),
          { memo: data.id, ...(this.by() === 'due' ? { due: this.dueDateOf(key) } : { assignee: key }) });
      }
      return;
    }
    // 担当者のかんばん：別の人の列に落としたら、担当者を変える窓
    if (this.by() === 'assignee') {
      const to = e.container.data;
      if (this.altOk(to) && to !== e.item.data.assigneeId) this.pendingAssignee.set({ issue: e.item.data, to });
      return;
    }
    const tz = this.tz();
    const day = (n: number) => dateKey(endOfDayIn(n, tz), tz);
    const col = e.container.data as DueCol;
    const plan: Partial<Record<DueCol, { date: string; pick: { min: string; max: string | null } | null }>> = {
      today: { date: day(DUE_COL_DAYS['today']), pick: null },
      tomorrow: { date: day(DUE_COL_DAYS['tomorrow']), pick: null },
      week: { date: day(DUE_COL_DAYS['week']), pick: { min: day(2), max: day(7) } },
      later: { date: day(DUE_COL_DAYS['later']), pick: { min: day(8), max: null } },
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
    afterEveryRender(() => this.measure());
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
    this.whoRaw.set(whoFromQuery(p, this.myUid));
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
  /** 人を選び直した（空なら全員） */
  setWho(list: string[]) {
    this.whoRaw.set(list);
    // 担当者別では列そのものが変わるので、スマホは最初の列に戻す（消えた列を指したままにしない）
    if (this.by() === 'assignee') {
      this.mobileCol.set(this.tabCols()[0]?.key ?? 'open');
      this.boardEl()?.nativeElement.scrollTo({ left: 0 });
    }
    this.updateUrl();
  }
  /** null は「すべて」。同じものをもう一度押しても解除 */
  setDue(d: DueFilter | null) {
    this.due.set(d === null || this.due() === d ? null : d);
    this.updateUrl();
  }

  /** 期限のプルダウンで選んだ（'all' は「すべて」） */
  pickDue(v: string | number) {
    this.due.set(v === 'all' ? null : (v as DueFilter));
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
      queryParams: { ...whoQuery(this.who()), due: this.due(), by: this.by() === 'status' ? null : this.by() },
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

  private canMove(i: Issue | InboxMemo, col: ColKey) {
    // 受信箱のメモ：登録は未着手から、の決まりなので、未着手の列だけ
    if (isMemo(i)) return col === 'open';
    if (colOf(i.status) === col) return true; // 元の列に戻すのはOK
    return this.moves(i).some((a) => a.t.to === COL_STATUS[col]);
  }

  /** 枠の強調用：今つかんでいるカードを、この列に落とせるか */
  canDropInto(col: ColKey) {
    if (this.draggingMemo()) return col === 'open';
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
    this.draggingMemo.set(null);
    this.frozen.set(null); // 止めていた間に届いた変更を、ここで反映する
    cancelAnimationFrame(this.raf);
    this.pointer = null;
  }

  // ---- ドラッグ中の自動スクロール ----
  /** ドラッグ中の、指（マウス）の位置 */
  private pointer: { x: number; y: number } | null = null;
  private raf = 0;

  /** 課題のカードでも受信箱のメモでも、使うのは指の位置だけ */
  onDragMoved(e: Pick<CdkDragMove<unknown>, 'pointerPosition'>) {
    this.pointer = e.pointerPosition;
    if (this.draggingMemo()) this.findTarget(e.pointerPosition);
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
      // 縦：指の下の列の中を流す（ページはもう縦に伸びないため）
      const col = [...el.querySelectorAll<HTMLElement>('.cards')].find((c) => {
        const cr = c.getBoundingClientRect();
        return p.x >= cr.left && p.x <= cr.right;
      });
      if (col) {
        const cr = col.getBoundingClientRect();
        if (p.y > cr.bottom - zone) col.scrollTop += speed(p.y - (cr.bottom - zone));
        else if (p.y < cr.top + zone) col.scrollTop -= speed(cr.top + zone - p.y);
      }
    }
    this.raf = requestAnimationFrame(this.autoScroll);
  };
  onDrop(e: CdkDragDrop<ColKey, ColKey, Issue>) {
    this.dragging.set(null);
    // 指が列の上にないところで離したら、何もしない（CDK は「最後に入った列」に落としたことにしてしまうため）
    if (e.previousContainer === e.container || !e.isPointerOverContainer) return;
    const data = e.item.data as Issue | InboxMemo;
    if (isMemo(data)) {
      // カードに重ねてサブタスクにしたなら、列に落ちたことは無視する（離した順番は CDK しだいなので、両方を見る）
      if (this.consumed === data.id || this.hoverCard()) return;
      if (e.container.data === 'open') this.issueForm.open(this.ctx.pid(), { memo: data.id });
      return;
    }
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

  /** 先に更新した人（移動できなかったときの知らせに使う） */
  conflictBy(latest: Issue) {
    return conflictWho(latest, this.ctx.members(), this.myUid);
  }

  async onDialogDone() {
    this.pending.set(null);
  }

  /** 削除できた：削除フォルダから元のステータスに戻す「元に戻す」を出す */
  onDeleted(i: Issue) {
    this.deleting.set(null);
    this.undo.offer('delete.moved', { n: String(i.number) },
      () => this.issueService.restoreIssue(this.ctx.pid(), i.id, this.myUid, this.tz()));
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
    this.edges();
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