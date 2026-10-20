import { Component, DestroyRef, OnInit, WritableSignal, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { SavedFilters } from './saved-filters';
import { ConflictError, IssueEdits, IssueService } from '../../core/issue/issue.service';
import { auth } from '../../core/firebase';
import { ProjectContext } from './project-context';
import { Clock } from '../../core/time/clock';
import { AuthService } from '../../core/auth/auth.service';
import { HelpTip } from '../../shared/help-tip';
import {
  DEFAULT_SETTINGS, ISSUE_TYPES, Issue, IssueType, Level, OPEN_STATUSES, labelsOf, hasWorkaround, MAX_LABELS_PER_ISSUE
} from '../../core/models';
import { LabelChip } from '../../shared/label-chip';
import { PriorityMark } from '../../shared/priority-mark';
import { compareIssues, isManualPriority, isStale, priorityOf } from '../../core/issue/priority';
import { formatDateTime, relativeTime, remainingOf, shortDue, endOfDayIn, parseLocalInput, toLocalInput } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { csvFileName, downloadText, issuesToCsv } from '../../core/issue/csv';
import { issueMatches, terms } from '../../core/search/match';
import { Selection } from '../../shared/selection';
import { BulkBar } from '../../shared/bulk-bar';
import { MemberSelect } from '../../shared/member-select';
import { NotificationService } from '../../core/notification/notification.service';
import { setDoc } from 'firebase/firestore';
import { PeopleFilter, whoFromQuery, whoQuery } from '../../shared/people-filter';

type SortKey = 'priority' | 'due' | 'number' | 'updated';
type BulkAction = 'assignee' | 'labels' | 'importance' | 'due' | 'delete';
const LOCKED = ['closed', 'merged', 'deleted'];
type Dir = 'asc' | 'desc';

/** 並べ替えを選んだときの初期の向き */
const DEFAULT_DIR: Record<SortKey, Dir> = {
  priority: 'asc', due: 'asc', number: 'desc', updated: 'desc',
};

@Component({
  selector: 'app-tab-list',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelChip, PriorityMark, BulkBar, MemberSelect, PeopleFilter, SavedFilters],
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

      <div class="people">
        <app-people-filter [members]="assignable()" [counts]="ctx.activeCount()" [value]="who()"
          (picked)="setWho($event)" />
        <app-saved-filters [pid]="pid()" [current]="currentQuery()" (applied)="applySaved($event)" />
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
        <div class="count-row">
          @if (canBulk() && visible().length) {
            <label class="pick-all">
              <input type="checkbox" [checked]="allPicked()" (change)="sel.toggleAll(visibleIds())" />
              {{ 'bulk.selectAll' | t }}
            </label>
          }
          <p class="count">{{ 'list.count' | t: { n: '' + visible().length } }}</p>
        </div>
        @if (bulkResult(); as r) {
          <div class="notice" role="status">
            <span>
              {{ r.key | t: { n: '' + r.n } }}
              @if (r.failed.length) { {{ 'bulk.failed' | t: { n: '' + r.failed.length, list: r.failed.join(', ') } }} }
              @if (r.tooMany) { {{ 'bulk.tooMany' | t: { n: '' + r.tooMany } }} }
            </span>
            <button type="button" class="link" (click)="bulkResult.set(null)">{{ 'projects.dismiss' | t }}</button>
          </div>
        }
        <ul class="list">
          @for (i of visible(); track i.id) {
            <li class="issue" [class.done]="!isActive(i)" [class.picked]="sel.has(i.id)">
              @if (canBulk()) {
                <input type="checkbox" class="pick" [checked]="sel.has(i.id)" (change)="sel.toggle(i.id)"
                  [attr.aria-label]="'bulk.select' | t: { n: '' + i.number }" />
              }
              @if (isActive(i)) {
                <app-priority-mark [level]="prio(i)" [manual]="manual(i)" showText />
              } @else {
                <span class="prio-none"></span>
              }
              <span class="num">#{{ i.number }}</span>
              @if (i.recurringId) {
                <span class="recur" [title]="'recurring.badge' | t" role="img" [attr.aria-label]="'recurring.badge' | t">
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m17 2 4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" />
                    <path d="m7 22-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></svg></span>
              }
              <a class="name" [routerLink]="['/p', pid(), 'i', i.id]">{{ i.title }}</a>
          @for (l of rowLabels(i); track l.id) { <app-label-chip [label]="l" /> }
              @if (i.status !== 'open') { <span class="st">{{ 'status.' + i.status | t }}</span> }
              @if (stale(i)) {
                <span class="stale" [title]="'stale.title' | t: { n: '' + staleDays() }">{{ 'stale.label' | t }}</span>
              }
              @if (wa(i)) { <span class="wa">{{ 'workaround.label' | t }}</span> }
              @if (i.subtaskTotal) {
                <span class="subs" [class.all]="i.subtaskDone === i.subtaskTotal"
                  [title]="'subtask.progress' | t: { done: '' + (i.subtaskDone ?? 0), total: '' + i.subtaskTotal }"
                  [attr.aria-label]="'subtask.progress' | t: { done: '' + (i.subtaskDone ?? 0), total: '' + i.subtaskTotal }">
                  <span aria-hidden="true">☑ {{ i.subtaskDone ?? 0 }}/{{ i.subtaskTotal }}</span></span>
              }
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
        @if (canBulk() && sel.any()) {
          <div class="bulk-wrap">
            @if (bulkAction(); as a) {
              <div class="bulk-panel">
                @switch (a) {
                  @case ('assignee') {
                    <app-member-select placeholder="bulk.chooseAssignee" [members]="assignable()" [value]="bulkAssignee()"
                      (picked)="bulkAssignee.set($event)" />
                   @if (resolvedPicked()) { <p class="warn">{{ 'bulk.resolvedNote' | t: { n: '' + resolvedPicked() } }}</p> }
                  }
                  @case ('labels') {
                    <div class="chips">
                      <button type="button" [class.on]="bulkLabelMode() === 'add'" (click)="bulkLabelMode.set('add')">
                        {{ 'bulk.addLabels' | t }}</button>
                      <button type="button" [class.on]="bulkLabelMode() === 'remove'" (click)="bulkLabelMode.set('remove')">
                        {{ 'bulk.removeLabels' | t }}</button>
                    </div>
                    <div class="chips">
                      @for (l of labels(); track l.id) {
                        <button type="button" [class.on]="bulkLabels().includes(l.id)" (click)="toggleBulkLabel(l.id)">{{ l.name }}</button>
                      }
                    </div>
                  }
                  @case ('importance') {
                    <div class="chips">
                      @for (l of levels; track l) {
                        <button type="button" [class.on]="bulkImportance() === l" (click)="bulkImportance.set(l)">
                          {{ 'importance.' + l | t }}</button>
                      }
                    </div>
                  }
                  @case ('due') {
                    <div class="chips">
                      @for (p of duePresets; track p.key) {
                        <button type="button" (click)="pickBulkDue(p.days)">{{ 'duePresets.' + p.key | t }}</button>
                      }
                    </div>
                    <input type="datetime-local" [ngModel]="bulkDueInput" (ngModelChange)="onBulkDue($event)" />
                    @if (bulkDuePast()) { <p class="warn">{{ 'dueDialog.pastWarning' | t }}</p> }
                  }
                  @case ('delete') {
                    <p class="help">{{ 'delete.note' | t }}</p>
                  }
                }
                @if (a === 'assignee' || a === 'due' || a === 'delete') {
                  <textarea [(ngModel)]="bulkReason" rows="2" [attr.aria-label]="'edit.reason' | t"
                    [placeholder]="(a === 'delete' ? 'delete.reasonHint' : 'edit.reasonHint') | t"></textarea>
                }
                @if (skipped() && a !== 'delete') { <p class="help">{{ 'bulk.skipped' | t: { n: '' + skipped() } }}</p> }
                <div class="row">
                  <button type="button" class="link" (click)="bulkAction.set(null)">{{ 'workflow.cancel' | t }}</button>
                  <button type="button" class="primary" [class.danger]="a === 'delete' || bulkDuePast()"
                    [disabled]="bulkBusy() || !bulkReady()" (click)="applyBulk()">
                    {{ 'bulk.run' | t: { n: '' + (a === 'delete' ? picked().length : targets().length) } }}</button>
                </div>
              </div>
            }
            <app-bulk-bar [count]="sel.count()" (clear)="sel.clear(); bulkAction.set(null)">
              <button type="button" class="bulk-btn" (click)="openBulk('assignee')">{{ 'bulk.assignee' | t }}</button>
              <button type="button" class="bulk-btn" (click)="openBulk('labels')">{{ 'bulk.labels' | t }}</button>
              <button type="button" class="bulk-btn" (click)="openBulk('importance')">{{ 'bulk.importance' | t }}</button>
              <button type="button" class="bulk-btn" (click)="openBulk('due')">{{ 'bulk.due' | t }}</button>
              @if (ctx.role() === 'admin') {
                <button type="button" class="bulk-btn danger" (click)="openBulk('delete')">{{ 'bulk.delete' | t }}</button>
              }
            </app-bulk-bar>
          </div>
        }
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
    .people { margin: 8px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
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
    .count-row { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .count-row .count { margin: 0; }
    .pick-all { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    .pick, .pick-all input { width: 18px; height: 18px; cursor: pointer; }
    .issue.picked { background: var(--primary-bg); }
    .bulk-wrap { position: sticky; bottom: 12px; z-index: 15; display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .bulk-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 10px;
      background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
    .bulk-panel textarea, .bulk-panel input[type='datetime-local'] { font-size: 16px; padding: 8px 10px; }
    .bulk-btn { min-height: 36px; padding: 0 12px; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 18px;
      background: none; color: inherit; font-size: 13px; cursor: pointer; }
    .bulk-btn:hover { background: rgba(255, 255, 255, 0.15); }
    .bulk-btn.danger { border-color: var(--danger); }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .primary.danger { background: var(--danger); }
    .warn { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12px;
      background: var(--warning-bg); color: var(--warning-text); }    
    .subs { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .subs.all { color: var(--success-text); font-weight: bold; }
    .recur { display: inline-flex; color: var(--text-muted); }
      `,
})
export class TabList implements OnInit {
  protected ctx = inject(ProjectContext);
  /** 値は入れ物の共有の置き場から直接読む（読むだけなので asReadonly） */
  pid = this.ctx.pid.asReadonly();
  members = this.ctx.members.asReadonly();
  canCreate = this.ctx.canCreate;
  isViewer = computed(() => this.ctx.role() === 'viewer');
  labels = computed(() => this.ctx.project()?.labels ?? []);
  private notifications = inject(NotificationService);
  private readonly myUid = auth.currentUser!.uid;

  // ---- まとめて操作 ----
  readonly sel = new Selection();
  /** 閲覧者・アーカイブ中は、変えられる課題がないので、チェックを出さない */
  canBulk = computed(() => !this.isViewer() && !this.ctx.archived());
  visibleIds = computed(() => this.visible().map((i) => i.id));
  allPicked = computed(() => this.sel.allOf(this.visibleIds()));
  /** 選んでいる課題（見えているものだけ） */
  picked = computed(() => this.visible().filter((i) => this.sel.has(i.id)));
  /** そのうち自分が編集できる課題（ルールの editAllowed と同じ決まり） */
  targets = computed(() => this.picked().filter((i) => this.editable(i)));
  skipped = computed(() => this.picked().length - this.targets().length);
  resolvedPicked = computed(() => this.targets().filter((i) => i.status === 'resolved').length);
  bulkAction = signal<BulkAction | null>(null);
  bulkBusy = signal(false);
  bulkResult = signal<{ key: string; n: number; failed: number[]; tooMany: number } | null>(null);
  bulkAssignee = signal<string | null>(null);
  bulkLabels = signal<string[]>([]);
  bulkLabelMode = signal<'add' | 'remove'>('add');
  bulkImportance = signal<Level | null>(null);
  bulkDue = signal<Date | null>(null);
  bulkDueInput = '';
  bulkReason = '';
  readonly duePresets = [
    { key: 'today', days: 0 }, { key: 'tomorrow', days: 1 }, { key: 'in3', days: 3 }, { key: 'in7', days: 7 },
  ];
  bulkDuePast = computed(() => this.bulkAction() === 'due' && !!this.bulkDue()
    && this.bulkDue()!.getTime() <= this.clock.now());

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
  /** URL から読んだ「選んだ人」（抜けた人が混ざっていることもある） */
  private whoRaw = signal<string[]>([]);
  /** 絞り込みに使う人。担当者になれる人だけ残す（抜けた人は黙って外す。だれも残らなければ全員） */
  who = computed(() => {
    const ok = new Set(this.ctx.assignable().map((m) => m.uid));
    return this.whoRaw().filter((u) => ok.has(u));
  });
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
  hasCondition = computed(() => !!this.q().trim() || this.who().length > 0 || this.activeCount() > 0);

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
    const who = new Set(this.who());
    if (who.size) list = list.filter((i) => who.has(i.assigneeId));
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
    // 絞り込みで見えなくなった課題は、選択から外す（見えないものを操作しないため）
    effect(() => this.sel.keepOnly(this.visibleIds()));
    inject(DestroyRef).onDestroy(() => this.ctx.listView.set(null));
  }

  async ngOnInit() {
    // 削除の知らせは1回だけ。読んだら履歴から消し、再読み込みで出し直さない
    const { deleted, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    if (deleted !== undefined) history.replaceState(rest, '');
    // URLから条件を復元する
    this.readQuery(this.route.snapshot.queryParamMap);
    await this.ensureAll();
  }

  /**
   * 条件を読んで、全部の欄に入れる（書いていない欄は初期値に戻す）。
   * 開いたときと、保存した絞り込みを当てたときの両方で使う
   */
  private readQuery(p: ParamMap) {
    this.q.set(p.get('q') ?? '');
    this.scope.set(p.get('scope') === 'all' ? 'all' : 'open');
    this.whoRaw.set(whoFromQuery(p, this.myUid));
    this.type.set(p.get('type') as IssueType | null);
    this.priority.set(p.get('priority') as Level | null);
    this.overdueOnly.set(p.get('overdue') === '1');
    this.staleOnly.set(p.get('stale') === '1');
    this.label.set(p.get('label'));
    const raw = p.get('sort') as SortKey | null;
    const s: SortKey = raw && this.sortKeys.includes(raw) ? raw : 'priority';
    this.sort.set(s);
    const d = p.get('dir');
    this.dir.set(d === 'asc' || d === 'desc' ? d : DEFAULT_DIR[s]);
  }

  /** 保存した絞り込みを当てる。同じ道のまま条件だけ変わるので、画面は作り直されない → ここで読み直す */
  applySaved(query: string) {
    this.readQuery(this.router.parseUrl('/?' + query).queryParamMap);
    this.changed();
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

  /** URL に書く条件（初期値のものは null にして、URL から消す） */
  private queryParams = computed(() => ({
    q: this.q().trim() || null,
    scope: this.scope() === 'all' ? 'all' : null,
    ...whoQuery(this.who()),
    type: this.type(),
    priority: this.priority(),
    overdue: this.overdueOnly() ? '1' : null,
    stale: this.staleOnly() ? '1' : null,
    label: this.label(),
    sort: this.sort() === 'priority' ? null : this.sort(),
    dir: this.dir() === DEFAULT_DIR[this.sort()] ? null : this.dir(),
  }));

  /** 今の条件を文字列にしたもの（保存する形。条件がなければ空） */
  currentQuery = computed(() => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(this.queryParams())) if (v != null && v !== '') u.set(k, String(v));
    return u.toString();
  });

  /** 条件が変わったら、URLを書き換えて、必要なら全件を読む */
  private changed() {
    this.router.navigate([], { relativeTo: this.route, replaceUrl: true, queryParams: this.queryParams() });
    this.ensureAll();
  }

  /** ヘッダーの検索から来た言葉の絞り込みを外す */
  clearQ() { this.q.set(''); this.changed(); }
  /** 人を選び直した（空なら全員） */
  setWho(list: string[]) { this.whoRaw.set(list); this.changed(); }

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
    this.whoRaw.set([]);
    this.type.set(null);
    this.priority.set(null);
    this.label.set(null);
    this.overdueOnly.set(false);
    this.staleOnly.set(false);
    this.changed();
  }

  /** 編集できるか：管理者・提起者・担当者。クローズ・統合済み・削除済みは不可 */
  private editable(i: Issue) {
    if (LOCKED.includes(i.status)) return false;
    const r = this.ctx.role();
    return r === 'admin' || (r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid));
  }

  openBulk(a: BulkAction) {
    this.bulkAssignee.set(null);
    this.bulkLabels.set([]);
    this.bulkLabelMode.set('add');
    this.bulkImportance.set(null);
    this.bulkDue.set(null);
    this.bulkDueInput = '';
    this.bulkReason = '';
    this.bulkResult.set(null);
    this.bulkAction.set(this.bulkAction() === a ? null : a);
  }

  toggleBulkLabel(id: string) {
    this.bulkLabels.update((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  }
  pickBulkDue(days: number) {
    const d = endOfDayIn(days, this.tz());
    this.bulkDue.set(d);
    this.bulkDueInput = toLocalInput(d, this.tz());
  }
  onBulkDue(v: string) {
    this.bulkDueInput = v;
    this.bulkDue.set(parseLocalInput(v, this.tz()));
  }

  /** 実行できるか：選ぶものを選び、理由が要るものは理由がある */
  bulkReady() {
    const a = this.bulkAction();
    const reason = !!this.bulkReason.trim();
    if (a === 'assignee') return !!this.bulkAssignee() && reason && this.targets().length > 0;
    if (a === 'labels') return this.bulkLabels().length > 0 && this.targets().length > 0;
    if (a === 'importance') return !!this.bulkImportance() && this.targets().length > 0;
    if (a === 'due') return !!this.bulkDue() && reason && this.targets().length > 0;
    if (a === 'delete') return reason && this.picked().length > 0;
    return false;
  }

  /** 選んだ課題に、1件ずつ保存する。1件失敗しても残りは続け、最後にまとめて知らせる */
  async applyBulk() {
    const a = this.bulkAction();
    if (!a || !this.bulkReady()) return;
    const reason = this.bulkReason.trim();
    const pid = this.pid();
    let changed = 0;
    let tooMany = 0;
    const failed: number[] = [];
    /** 課題ごとに、変える中身を決める（変わらないなら null） */
    const make = (i: Issue): IssueEdits | null => {
      if (a === 'assignee') return this.bulkAssignee() !== i.assigneeId ? { assigneeId: this.bulkAssignee()! } : null;
      if (a === 'importance') return this.bulkImportance() !== i.importance ? { importance: this.bulkImportance()! } : null;
      if (a === 'due') return this.bulkDue()!.getTime() !== i.dueAt.toMillis() ? { dueAt: this.bulkDue()! } : null;
      const cur = i.labelIds ?? [];
      const next = this.bulkLabelMode() === 'add'
        ? [...new Set([...cur, ...this.bulkLabels()])]
        : cur.filter((x) => !this.bulkLabels().includes(x));
      if (next.length > MAX_LABELS_PER_ISSUE) {
        tooMany++;
        return null;
      }
      return next.length === cur.length && next.every((x) => cur.includes(x)) ? null : { labelIds: next };
    };
    const list = a === 'delete' ? this.picked().filter((i) => i.status !== 'deleted') : this.targets();
    this.bulkBusy.set(true);
    for (const i of list) {
      try {
        if (a === 'delete') {
          await this.withRetry(i, (b) => this.issueService.deleteIssue(pid, b, reason, this.myUid, this.tz()));
        } else {
          const edits = make(i);
          if (!edits) continue;
          const r = a === 'assignee' || a === 'due' ? reason : '';
          await this.withRetry(i, (b) => this.issueService.updateIssue(pid, b, edits, r, this.myUid, this.tz(), false));
        }
        changed++;
      } catch (e) {
        console.error(e);
        failed.push(i.number);
      }
    }
    // 担当者をまとめて変えたら、新しい担当者に1通だけ（「引き継ぎ」の知らせを使う）
    if (a === 'assignee' && changed) await this.notifyHandover(this.bulkAssignee()!, changed, reason);
    this.bulkResult.set({ key: a === 'delete' ? 'bulk.deleted' : 'bulk.done', n: changed, failed, tooMany });
    this.bulkAction.set(null);
    this.sel.clear();
    this.bulkBusy.set(false);
  }

  /** 選んだあとに、ほかの人が課題を変えていたら、最新を土台にもう一度（まとめて操作は、選んだ値で上書きする） */
  private async withRetry(i: Issue, save: (base: Issue) => Promise<void>) {
    try {
      await save(i);
    } catch (e) {
      if (!(e instanceof ConflictError) || LOCKED.includes(e.latest.status)) throw e;
      await save(e.latest);
    }
  }

  private async notifyHandover(to: string, n: number, reason: string) {
    const note = this.notifications.notice(to, 'handover', {
      pid: this.pid(), projectName: this.ctx.project()?.name ?? '', iid: null, issueNumber: n, issueTitle: '',
    }, reason);
    if (note) await setDoc(note.ref, note.data).catch((e) => console.warn('まとめての知らせを送れませんでした', e));
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