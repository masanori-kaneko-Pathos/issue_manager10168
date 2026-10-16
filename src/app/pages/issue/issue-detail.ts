import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FirestoreError, Unsubscribe } from 'firebase/firestore';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { ProjectService } from '../../core/project/project.service';
import { ConflictError, EMPTY_STATUS_PAYLOAD, IssueService, conflictWho } from '../../core/issue/issue.service';
import {
  CAUSE_CATEGORIES, CauseCategory, DEFAULT_SETTINGS, Issue, IssueRelation, Label, Level, Member, Project, Role,
  TimelineItem, labelsOf, OPEN_STATUSES,
} from '../../core/models';
import { LinkDialog } from './link-dialog';
import { StatusDialog } from '../../shared/status-dialog';
import { LabelChip } from '../../shared/label-chip';
import { IssueEdit } from './issue-edit-dialog';
import { HelpTip } from '../../shared/help-tip';
import { PriorityMark } from '../../shared/priority-mark';
import { isStale, priorityOf } from '../../core/issue/priority';
import { formatDateTime, remainingOf } from '../../core/time/time';
import { Transition, availableTransitions } from '../../core/issue/workflow';
import { I18nService, TPipe } from '../../i18n/i18n';
import { MergeDialog } from './merge-dialog';

/** 経緯の「編集した欄」の項目名 → 翻訳キー（issue.〇〇）。名前が違うものだけ書く */
const FIELD_LABEL_KEYS: Record<string, string> = { assigneeId: 'assignee', dueAt: 'due' };
/** 関連課題の欄の並び（種類と向きの組。「関連」は向きを分けない） */
const LINK_GROUPS = [
  'waitsFor_out', 'waitsFor_in', 'recurrence_out', 'recurrence_in', 'duplicate_out', 'duplicate_in', 'relates',
];
function linkGroupOf(kind: string, dir: string) {
  return kind === 'relates' ? 'relates' : `${kind}_${dir}`;
}

@Component({
  selector: 'app-issue-detail',
  imports: [FormsModule, RouterLink, TPipe, IssueEdit, HelpTip, LabelChip, StatusDialog, PriorityMark, LinkDialog,
    MergeDialog],
  template: `
    <header class="bar">
      <button type="button" class="link" (click)="back()">{{ 'common.back' | t }}</button>
      @if (projectName()) {
        <nav class="crumbs">
          <a class="crumb-project" [routerLink]="['/p', pid]">{{ projectName() }}</a>
          @if (issue(); as i) {
            <span aria-hidden="true">›</span><span class="crumb-num">#{{ i.number }}</span>
          }
        </nav>
      }
    </header>
    <main>
      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!issue()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        @let i = issue()!;
        <p class="num">#{{ i.number }} · {{ 'issueTypes.' + i.type | t }}
          @if (i.relatedFrom; as r) {
            · <a class="related" [routerLink]="['/p', pid, 'i', r.iid]">{{ 'prevention.from' | t: { n: '' + r.number } }}</a>
          }
        </p>
        <h1>{{ i.title }}</h1>
        <div class="badges">
          <span class="status" [attr.data-s]="i.status">{{ 'status.' + i.status | t }}</span>
          @if (isActive(i)) {
            <span class="prio" [attr.data-p]="priority()">
              {{ 'issue.priority' | t }}：{{ 'priority.' + priority() | t }}
              @if (i.priorityOverride) {
                {{ 'priorityEdit.manual' | t: { auto: i18n.t('priority.' + autoPriority()) } }}
              }
            </span>
            <app-help-tip [keys]="['help.priority']" />
          }
          @if (i.status !== 'closed' && i.status !== 'rejected' && i.status !== 'deleted') {
            <span class="due" [class.overdue]="overdue()">{{ dueText() }}</span>
          }
          @if (stale()) {
            <span class="stale" [title]="'stale.title' | t: { n: '' + staleDays() }">{{ 'stale.label' | t }}</span>
          }
        </div>
        @if (i.statusReason && (i.status === 'on_hold' || i.status === 'rejected')) {
          <p class="reason">{{ i.statusReason }}</p>
        }
        @if (i.status === 'on_hold' && waitingFor().length) {
          <div class="reason waiting">
            <span>{{ 'links.groups.waitsFor_out' | t }}：</span>
            @for (r of waitingFor(); track r.id) {
              @let li = linkedIssue(r);
              @if (li) {
                <a [routerLink]="['/p', r.pid, 'i', r.iid]">#{{ li.number }} {{ li.title }}（{{ 'status.' + li.status | t }}）</a>
              } @else if (li === null) {
                <span>{{ 'links.unreadable' | t }}</span>
              }
            }
          </div>
        }
        @if (i.status === 'deleted') {
          <div class="trash" role="status">
            <p><strong>{{ 'delete.inTrash' | t }}</strong></p>
            <p>{{ 'delete.by' | t: { name: memberName(i.deletedBy ?? ''), when: i.deletedAt ? fmt(i.deletedAt) : '' } }}</p>
            @if (i.deletedReason) { <p class="pre">{{ i.deletedReason }}</p> }
            @if (canRestore()) {
              <button type="button" class="primary" [disabled]="busy()" (click)="restore()">{{ 'delete.restore' | t }}</button>
            }
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
          </div>
        }

        @if (i.status === 'merged' && i.mergedInto; as m) {
          <div class="merged" role="status">
            <p><strong>{{ 'merge.banner' | t }}
              <a [routerLink]="['/p', pid, 'i', m.iid]">#{{ m.number }}</a></strong></p>
            @if (i.statusReason) { <p class="pre">{{ i.statusReason }}</p> }
          </div>
        }

        <dl class="fields">
          <dt>{{ 'issue.assignee' | t }}</dt><dd>{{ memberName(i.assigneeId) }}</dd>
          <dt>{{ 'detail.reporter' | t }}</dt><dd>{{ memberName(i.reporterId) }}</dd>
          <dt>{{ 'issue.importance' | t }}</dt><dd>{{ 'importance.' + i.importance | t }}</dd>
           @if (issueLabels().length) {
            <dt>{{ 'issue.labelIds' | t }}</dt>
            <dd class="label-row">@for (l of issueLabels(); track l.id) { <app-label-chip [label]="l" /> }</dd>
          }
          <dt>{{ 'issue.due' | t }}</dt><dd>{{ dueLabel() }}</dd>
          <dt>{{ 'issue.doneCriteria' | t }}</dt><dd class="pre">{{ i.doneCriteria }}</dd>
          @if (i.description.trim()) {
            <dt>{{ 'issue.description' | t }}</dt><dd class="pre">{{ i.description }}</dd>
          }
          @if (i.occurredOn) {
            <dt>{{ 'issue.occurredOn' | t }}</dt><dd>{{ dayLabel(i.occurredOn) }}</dd>
          }
          @if (i.impact) {
            <dt>{{ 'issue.impact' | t }}</dt><dd class="pre">{{ i.impact }}</dd>
          }
          @if (i.cause) {
            <dt>{{ 'workflow.cause' | t }}</dt><dd class="pre">{{ i.cause }}</dd>
          }
          @if (i.countermeasure) {
            <dt>{{ 'workflow.countermeasure' | t }}</dt><dd class="pre">{{ i.countermeasure }}</dd>
          }
          @if (i.causeCategory) {
            <dt>{{ 'workflow.causeCategory' | t }}</dt><dd>{{ 'causeCategories.' + i.causeCategory | t }}</dd>
          }
          @if (i.effect) {
            <dt>{{ 'workflow.effect' | t }}</dt><dd>{{ 'workflow.effectOpts.' + i.effect | t }}</dd>
            @if (i.learning) { <dt>{{ 'workflow.learning' | t }}</dt><dd class="pre">{{ i.learning }}</dd> }
          }
        </dl>

        @if (i.status === 'resolved' || i.status === 'closed' || preventions().length) {
          <section class="prevention">
            <h2>{{ 'prevention.title' | t }} <app-help-tip [keys]="['prevention.help']" /></h2>
            @for (p of preventions(); track p.id) {
              <a class="prev-row" [routerLink]="['/p', pid, 'i', p.id]">
                <span class="prev-title">#{{ p.number }} {{ p.title }}</span>
                <span class="prev-st">{{ 'status.' + p.status | t }}</span>
              </a>
            }

            @if (i.status === 'resolved' || i.status === 'closed') {
              @if (i.effect === 'partial' || i.effect === 'no') {
                <p class="recommend">{{ 'prevention.recommend' | t }}</p>
              }
              @if (canCreate()) {
                <a class="prev-btn" [routerLink]="['/p', pid, 'new']" [queryParams]="{ from: i.id }">
                  {{ 'prevention.create' | t }}</a>
              }
            }
          </section>
        }

        @if (relations().length || canLink()) {
          <section class="links">
            <h2>{{ 'links.title' | t }} <app-help-tip [keys]="['links.help']" /></h2>
            @for (g of linkGroups(); track g.key) {
              <p class="link-group">{{ 'links.groups.' + g.key | t }}</p>
              @for (r of g.rels; track r.id) {
                @let li = linkedIssue(r);
                <div class="prev-row">
                  @if (li) {
                    <a class="prev-title" [routerLink]="['/p', r.pid, 'i', r.iid]">
                      @if (r.pid !== pid && projectNames()[r.pid]) {
                        <span class="link-proj">{{ projectNames()[r.pid] }}</span>
                      }
                      #{{ li.number }} {{ li.title }}</a>
                    <span class="prev-st">{{ 'status.' + li.status | t }}</span>
                  } @else if (li === null) {
                    <span class="prev-title muted">{{ 'links.unreadable' | t }}</span>
                  } @else {
                    <span class="prev-title muted">{{ 'common.loading' | t }}</span>
                  }
                  @if (canUnlink(r)) {
                    <button type="button" class="icon" [attr.aria-label]="'links.remove' | t" [title]="'links.remove' | t"
                      [disabled]="busy()" (click)="unlink(r)">✕</button>
                  }
                </div>
              }
            }
            @if (linkError()) { <p class="error" role="alert">{{ linkError() | t }}</p> }
            @if (canLink()) {
              <button type="button" class="add-link" (click)="linkOpen.set(true)">{{ 'links.add' | t }}</button>
            }
            @if (canLink() && (i.status === 'resolved' || i.status === 'closed')) {
              <a class="add-link" [routerLink]="['/p', pid, 'new']" [queryParams]="{ recur: i.id }">
                {{ 'links.recurCreate' | t }}</a>
            }
          </section>
        }
        @if (linkOpen()) {
          <app-link-dialog [pid]="pid" [iid]="iid" [number]="i.number" [relations]="relations()"
            (done)="linkOpen.set(false)" (cancel)="linkOpen.set(false)" />
        }

        @if (i.status !== 'deleted') {
        <section class="tools">
          <button type="button" [disabled]="!canEdit()" (click)="openEdit()">{{ 'edit.open' | t }}</button>
          <button type="button" [disabled]="!canSetPriority()" (click)="openPriority()">
            {{ 'priorityEdit.open' | t }}</button>
          @if (showCauseButton()) {
            <button type="button" [disabled]="!canEditCause()" (click)="openCause()">{{ 'causeEdit.open' | t }}</button>
          }
          @if (showMerge()) {
            <button type="button" [disabled]="!canMerge()" (click)="openMerge()">{{ 'merge.open' | t }}</button>
          }
          <button type="button" class="danger-btn" [disabled]="!canDelete()" (click)="openDelete()">
            {{ 'delete.open' | t }}</button>
          @if (toolDenied().length) { <app-help-tip kind="denied" [keys]="toolDenied()" /> }
        </section>

        @if (prioPanel()) {
          <section class="panel">
            <h2>{{ 'priorityEdit.open' | t }}</h2>
            <div class="chips">
              @for (l of levels; track l) {
                <button type="button" [class.on]="prioChoice() === l" (click)="prioChoice.set(l)">
                  <app-priority-mark [level]="l" decorative />{{ 'priority.' + l | t }}</button>
              }
              @if (i.priorityOverride) {
                <button type="button" [class.on]="prioChoice() === 'auto'" (click)="prioChoice.set('auto')">
                  {{ 'priorityEdit.auto' | t }}</button>
              }
            </div>
            <label class="field">{{ 'priorityEdit.reason' | t }}
              <textarea [(ngModel)]="prioReason" rows="2" [placeholder]="'priorityEdit.reasonHint' | t"></textarea>
            </label>
            @if (prioConflict(); as c) {
              @let w = who(c.latest);
              <div class="conflict" role="alert">
                <p>{{ w.key | t: w.params }}</p>
                @if (c.blocked) {
                  <p>{{ 'conflict.statusChanged' | t: { status: i18n.t('status.' + c.latest.status) } }}</p>
                } @else {
                  <p>{{ 'conflict.retry' | t }}</p>
                }
              </div>
            }
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            <div class="row">
              <button type="button" class="link" (click)="prioPanel.set(false)">{{ 'workflow.cancel' | t }}</button>
              <button type="button" class="primary"
                [disabled]="busy() || !prioChoice() || !prioReason.trim() || !!prioConflict()?.blocked"
                (click)="confirmPriority()">{{ 'workflow.confirm' | t }}</button>
            </div>
          </section>
        }

        @if (causePanel()) {
          <section class="panel">
            <h2>{{ 'causeEdit.title' | t }}</h2>
            <p class="help">{{ 'causeEdit.help' | t }}</p>
            <label class="field">{{ 'workflow.cause' | t }}
              <textarea [(ngModel)]="causeText" rows="3" maxlength="2000"></textarea>
            </label>
            <label class="field">{{ 'workflow.countermeasure' | t }}
              <textarea [(ngModel)]="counterText" rows="3" maxlength="2000"></textarea>
            </label>
            <fieldset>
              <legend>{{ 'workflow.causeCategory' | t }}</legend>
              <div class="chips">
                @for (c of causeCategories; track c) {
                  <button type="button" [class.on]="causeCat() === c" [attr.aria-pressed]="causeCat() === c"
                    (click)="causeCat.set(causeCat() === c ? null : c)">{{ 'causeCategories.' + c | t }}</button>
                }
              </div>
            </fieldset>
            @if (causeConflict(); as c) {
              @let w = who(c.latest);
              <div class="conflict" role="alert">
                <p>{{ w.key | t: w.params }}</p>
                @if (c.blocked) {
                  <p>{{ 'conflict.statusChanged' | t: { status: i18n.t('status.' + c.latest.status) } }}</p>
                } @else {
                  <p>{{ 'conflict.retry' | t }}</p>
                }
              </div>
            }
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            <div class="row">
              <button type="button" class="link" (click)="causePanel.set(false)">{{ 'workflow.cancel' | t }}</button>
              <button type="button" class="primary" [disabled]="busy() || !!causeConflict()?.blocked"
                (click)="confirmCause()">{{ 'edit.save' | t }}</button>
            </div>
          </section>
        }

        @if (delPanel()) {
          <section class="panel">
            <h2>{{ 'delete.title' | t }}</h2>
            <p class="help">{{ 'delete.note' | t }}</p>
            <label class="field">{{ 'delete.reason' | t }}
              <textarea [(ngModel)]="delReason" rows="2" [placeholder]="'delete.reasonHint' | t"></textarea>
            </label>
            @if (delConflict(); as c) {
              @let w = who(c);
              <div class="conflict" role="alert">
                <p>{{ w.key | t: w.params }}</p>
                <p>{{ 'conflict.retry' | t }}</p>
              </div>
            }
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            <div class="row">
              <button type="button" class="link" (click)="delPanel.set(false)">{{ 'workflow.cancel' | t }}</button>
              <button type="button" class="primary danger" [disabled]="busy() || !delReason.trim()"
                (click)="confirmDelete()">{{ 'delete.confirm' | t }}</button>
            </div>
          </section>
        }

        @if (editing()) {
          <app-issue-edit-dialog [issue]="base()!" [members]="members()" [pid]="pid" [labels]="projectLabels()"
            (saved)="onEdited()" (cancel)="editing.set(false)" />
        }

        @if (mergeOpen()) {
          <app-merge-dialog [pid]="pid" [issue]="base()!" (done)="mergeOpen.set(false)" (cancel)="mergeOpen.set(false)" />
        }

        <section class="actions">
          @for (a of transitions(); track a.t.key) {
            <button type="button" [disabled]="!a.allowed || busy()" [class.on]="active()?.key === a.t.key"
              (click)="click(a.t)">{{ 'workflow.' + a.t.key | t }}</button>
          }
          @if (deniedReasons().length) { <app-help-tip kind="denied" [keys]="deniedReasons()" /> }
          @if (showRejectHelp()) { <app-help-tip [keys]="['help.reject']" /> }
        </section>
        @if (actionConflict(); as c) {
          @let w = who(c);
          <p class="error" role="alert">{{ w.key | t: w.params }} {{ 'conflict.again' | t }}</p>
        }

          @if (active(); as t) {
          <app-status-dialog [issue]="base()!" [transition]="t" [pid]="pid" [members]="members()"
            (done)="onStatusDone()" (cancel)="active.set(null)" />
        }
        } <!-- ここまで、削除フォルダにない課題だけ -->

        <section>
          <h2>{{ 'detail.timeline' | t }}</h2>
          <ul class="timeline">
            @for (item of timeline(); track item.id) {
              <li [class.comment]="item.kind === 'comment'">
                                <div class="meta">
                  {{ item.kind === 'comment' ? memberName(item.by) : eventText(item) }} · {{ when(item) }}
                  @if (item.editedAt && !item.deleted) {
                    <span class="edited" [title]="fmt(item.editedAt)">（{{ 'comment.edited' | t }}）</span>
                  }
                  @if (item.kind === 'comment' && !item.deleted && editingId() !== item.id && !projectArchived()
                    && i.status !== 'deleted') {
                    <span class="c-actions">
                      @if (item.by === myUid) {
                        <button type="button" class="icon" [attr.aria-label]="'comment.edit' | t" [title]="'comment.edit' | t"
                          (click)="startEdit(item)">✎</button>
                      }
                      @if (item.by === myUid || role() === 'admin') {
                        <button type="button" class="icon" [attr.aria-label]="'comment.delete' | t" [title]="'comment.delete' | t"
                          [disabled]="busy()" (click)="askDelete(item)">🗑</button>
                      }
                    </span>
                  }
                </div>
                @if (item.deleted) {
                  <p class="deleted">{{ 'comment.deletedBy' | t: { name: memberName(item.deletedBy!) } }}</p>
                } @else if (editingId() === item.id) {
                  <textarea class="edit-box" [(ngModel)]="editBody" rows="3"></textarea>
                  <div class="row">
                    <button type="button" class="link" (click)="editingId.set(null)">{{ 'workflow.cancel' | t }}</button>
                    <button type="button" class="primary" [disabled]="busy() || !editBody.trim()" (click)="saveEdit(item)">
                      {{ 'comment.save' | t }}</button>
                  </div>
                } @else if (item.body) {
                  <p class="pre">{{ item.body }}</p>
                }
                @if (item.changes?.dueAt; as c) {
                  <p class="change">{{ 'issue.due' | t }}：{{ fmt(c.from) }} → {{ fmt(c.to) }}</p>
                }
                @if (item.changes?.assigneeId; as c) {
                  <p class="change">{{ 'issue.assignee' | t }}：{{ memberName(c.from) }} → {{ memberName(c.to) }}</p>
                }
                @if (item.changes?.doneCriteria; as c) {
                  <p class="change pre">{{ 'issue.doneCriteria' | t }}：{{ c.from }} → {{ c.to }}</p>
                }
                @if (item.reason) { <p class="pre reason">{{ item.reason }}</p> }
              </li>
            }
          </ul>
          @if (i.status !== 'deleted') {
            <div class="comment-box">
              <textarea [(ngModel)]="comment" rows="3" [placeholder]="'detail.commentPlaceholder' | t"></textarea>
              <button type="button" class="primary" [disabled]="busy() || !comment.trim()" (click)="sendComment()">
                {{ 'detail.send' | t }}</button>
            </div>
          }
        </section>
      }
    </main>
  `,
  styles: `
    .bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
    .crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; color: var(--text-muted); }
    .crumb-project { display: block; min-width: 0; color: var(--primary); text-decoration: none;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .crumb-num { white-space: nowrap; }
    main { max-width: 720px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; margin: 4px 0 8px; overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin-top: 24px; }
    .num { color: var(--text-muted); font-size: 13px; margin: 0; }
    .badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .badges span { font-size: 12px; padding: 4px 10px; border-radius: 12px; background: var(--surface-muted); }
    .status[data-s='in_progress'] { background: var(--primary-bg); }
    .status[data-s='on_hold'] { background: var(--hold-bg); }
    .status[data-s='resolved'] { background: var(--success-bg); }
    .status[data-s='closed'], .status[data-s='rejected'] { background: var(--surface-muted); color: var(--text-secondary); }
    .prio[data-p='high'] { background: var(--danger-bg); color: var(--danger-text); }
    .prio[data-p='mid'] { background: var(--warning-bg); color: var(--warning-text); }
    .prio[data-p='low'] { background: var(--success-bg); color: var(--success-text); }
    .due.overdue { background: var(--danger-bg); color: var(--danger-text); font-weight: bold; }
    .reason { background: var(--warning-bg); padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; }
    .fields { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 16px 0; }
    .fields dt { color: var(--text-muted); font-size: 13px; }
    .fields dd { margin: 0; }
    .pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .actions button { min-height: 44px; padding: 0 16px; border: 1px solid var(--primary); color: var(--primary);
      background: var(--surface); border-radius: 8px; font-size: 14px; }
    .actions button.on { background: var(--primary); color: var(--on-primary); }
    .actions button:disabled { border-color: var(--border-strong); color: var(--text-disabled); }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    .panel { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 12px;
      display: flex; flex-direction: column; gap: 12px; }
    .panel h2 { margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    fieldset { border: none; padding: 0; margin: 0; }
    legend { font-size: 14px; font-weight: bold; }
    textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .chips button { display: inline-flex; align-items: center; gap: 6px;
      min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .criteria { background: var(--surface-alt); padding: 12px; border-radius: 8px; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 44px; }
    .check input { width: 22px; height: 22px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
    .conflict { padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .conflict p { margin: 0 0 4px; }
    .conflict p:last-child { margin-bottom: 0; }
      .status[data-s='deleted'] { background: var(--danger-bg); color: var(--danger-text); }
    .trash { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; padding: 12px;
      border-radius: 8px; background: var(--danger-bg); color: var(--danger-text); }
    .trash p { margin: 0; }
    .trash .primary { align-self: flex-start; }
    .primary.danger { background: var(--danger); }
    .tools .danger-btn { color: var(--danger-text); }
    .timeline { list-style: none; padding: 0; margin: 0; }
    .timeline li { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .timeline li.comment { background: var(--surface-alt); padding: 8px 12px; }
    .timeline .meta { font-size: 12px; color: var(--text-muted); }
    .comment-box { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .comment-box .primary { align-self: flex-end; }
    .tools { display: flex; gap: 8px; margin-bottom: 4px; align-items: center; }
    .tools button { min-height: 44px; padding: 0 16px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 8px; font-size: 14px; }
    .tools button:disabled { color: var(--text-disabled); }
    .change { font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; }
    .label-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .edited { font-size: 11px; color: var(--text-subtle); }
    .c-actions { float: right; display: inline-flex; gap: 4px; }
    .icon { min-width: 32px; min-height: 32px; border: none; background: none; border-radius: 6px;
      color: var(--text-muted); cursor: pointer; }
    .icon:hover { background: var(--surface-muted); }
    .deleted { margin: 4px 0 0; font-size: 13px; font-style: italic; color: var(--text-subtle); }
    .edit-box { width: 100%; box-sizing: border-box; margin-top: 6px; }
    .badges .stale { background: var(--warning-bg); color: var(--warning-text); }
    .related { font-size: 13px; }
    .prevention { margin: 8px 0 16px; display: flex; flex-direction: column; gap: 6px; }
    .prevention h2 { margin: 8px 0 0; }
    .prev-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; color: var(--text);
      text-decoration: none; border-bottom: 1px solid var(--border); }
    .prev-title { flex: 1; overflow-wrap: anywhere; }
    .prev-st { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--surface-muted); }
    .recommend { margin: 0; padding: 8px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); }
    .prev-btn { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px;
      border: 1px solid var(--primary); border-radius: 8px; color: var(--primary); text-decoration: none; font-size: 14px; }
    .links { margin: 8px 0 16px; display: flex; flex-direction: column; gap: 4px; }
    .links h2 { margin: 8px 0 0; }
    .link-group { margin: 8px 0 0; font-size: 12px; color: var(--text-muted); }
    .link-proj { font-size: 11px; color: var(--text-muted); margin-right: 6px; }
    .muted { color: var(--text-subtle); }
    .add-link { align-self: flex-start; min-height: 44px; padding: 0 16px; margin-top: 4px; border: 1px solid var(--primary);
      border-radius: 8px; color: var(--primary); background: var(--surface); font-size: 14px; cursor: pointer; }
    .waiting { display: flex; flex-wrap: wrap; gap: 4px 12px; white-space: normal; }
    a.add-link { display: inline-flex; align-items: center; text-decoration: none; }
    .status[data-s='merged'] { background: var(--surface-muted); color: var(--text-secondary); }
    .merged { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; padding: 12px; border-radius: 8px;
      background: var(--surface-alt); }
    .merged p { margin: 0; }
  `,
})
export class IssueDetail implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  protected i18n = inject(I18nService);

  readonly pid = this.route.snapshot.paramMap.get('pid')!;
  readonly iid = this.route.snapshot.paramMap.get('iid')!;
  readonly myUid = auth.currentUser!.uid;
  readonly levels: Level[] = ['high', 'mid', 'low'];

  // 編集と優先度の手動変更
  editing = signal(false);
  prioPanel = signal(false);
  prioChoice = signal<Level | 'auto' | null>(null);
  prioReason = '';
  /** 優先度のパネルを開いた時点の課題（衝突のあとは最新） */
  private prioBase = signal<Issue | null>(null);
  /** 優先度の保存で衝突した（blocked＝クローズ・却下されて、もう変えられない） */
  prioConflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 入力の要らないステータス変更で衝突したときの、最新の課題 */
  actionConflict = signal<Issue | null>(null);
  // 削除
  delPanel = signal(false);
  delReason = '';
  /** 削除のパネルを開いた時点の課題（衝突のあとは最新） */
  private delBase = signal<Issue | null>(null);
  delConflict = signal<Issue | null>(null);
  // 原因・対策（対応中・保留のときの下書き）
  readonly causeCategories = CAUSE_CATEGORIES;
  causePanel = signal(false);
  causeText = '';
  counterText = '';
  causeCat = signal<CauseCategory | null>(null);
  /** パネルを開いた時点の課題（衝突のあとは最新） */
  private causeBase = signal<Issue | null>(null);
  /** 保存で衝突した（blocked＝対応中・保留ではなくなって、もう書けない） */
  causeConflict = signal<{ latest: Issue; blocked: boolean } | null>(null);

  issue = signal<Issue | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  timeline = signal<TimelineItem[]>([]);
  projectLabels = signal<Label[]>([]);
  issueLabels = computed(() => labelsOf(this.issue()?.labelIds, this.projectLabels()));
  /** 役割・メンバー・プロジェクトの読み込み中 */
  private metaLoading = signal(true);
  /** 課題の最初の版が届いたか */
  private issueReady = signal(false);
  loading = computed(() => this.metaLoading() || !this.issueReady());
  private stops: Unsubscribe[] = [];
  /** モーダル（編集・ステータス変更）を開いた時点の課題。開いている間に変更が届いても、入力の土台は変えない */
  base = signal<Issue | null>(null);

  constructor() {
    // 詳細画面を離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => {
      this.stops.forEach((stop) => stop());
      this.linkStops.forEach((stop) => stop());
    });
  }
  busy = signal(false);
  error = signal('');

  // ステータス変更の入力
  // ステータス変更のモーダル（入力が要るものだけ開く）
  active = signal<Transition | null>(null);
  comment = '';
  // コメントのその場での編集
  editingId = signal<string | null>(null);
  editBody = '';
  /** アーカイブ中のプロジェクトでは、コメントの編集・削除のボタンを出さない */
  projectArchived = signal(false);
  /** この課題を元に作られた再発防止課題 */
  preventions = signal<Issue[]>([]);
  // ---- 関連課題 ----
  relations = signal<IssueRelation[]>([]);
  /** 相手の課題（キーは「pid/iid」。null＝読めない・見つからない。まだ届いていなければキーがない） */
  private linked = signal<Record<string, Issue | null>>({});
  private linkStops = new Map<string, Unsubscribe>();
  /** ほかのプロジェクトの名前（読めたものだけ） */
  projectNames = signal<Record<string, string>>({});
  linkOpen = signal(false);
  linkError = signal('');
  /** 付けられるのは、管理者とメンバー（アーカイブ中・削除フォルダの中は不可） */
  canLink = computed(() => this.canCreate() && this.issue()?.status !== 'deleted');
  linkGroups = computed(() => LINK_GROUPS
    .map((key) => ({ key, rels: this.relations().filter((r) => linkGroupOf(r.kind, r.dir) === key) }))
    .filter((g) => g.rels.length));
  /** 保留中に、理由の下に出す「完了待ち」（こちらから付けたもの） */
  waitingFor = computed(() => this.relations().filter((r) => r.kind === 'waitsFor' && r.dir === 'out'));
  /** 再発防止課題を作れるか：管理者とメンバー（アーカイブ中は不可） */
  canCreate = computed(() => (this.role() === 'admin' || this.role() === 'member') && !this.projectArchived());
  /** 停滞とみなす日数（開いたときにプロジェクトの設定から読む） */
  staleDays = signal(DEFAULT_SETTINGS.staleDays);
  stale = computed(() => {
    const i = this.issue();
    return !!i && isStale(i, this.staleDays(), this.clock.now());
  });
  /** 上の道しるべと、外されたときの知らせに使うプロジェクト名 */
  projectName = signal('');
  /** 外れた人の名前（uid → 名前） */
  private formerMembers: Record<string, string> = {};

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  priority = computed(() => priorityOf(this.issue()!, this.clock.now()));
  autoPriority = computed(() => priorityOf({ ...this.issue()!, priorityOverride: null }, this.clock.now()));
  canEdit = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || i.status === 'closed' || i.status === 'merged') return false;
    if (r === 'admin') return true;
    return r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid);
  });
  canSetPriority = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || !this.isActive(i)) return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });

  /** 原因・対策のボタンを出すか（対応中・保留のときだけ） */
  showCauseButton = computed(() => {
    const s = this.issue()?.status;
    return s === 'in_progress' || s === 'on_hold';
  });
  /** 原因・対策を書けるか：担当者と管理者（アーカイブ中は不可） */
  canEditCause = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || !this.showCauseButton() || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });


  /** 削除は管理者だけ（アーカイブ中は不可） */
  canDelete = computed(() => this.role() === 'admin' && !this.projectArchived());

  /** 統合のボタンを出すか：未クローズのときだけ */
  showMerge = computed(() => {
    const s = this.issue()?.status;
    return !!s && OPEN_STATUSES.includes(s);
  });
  /** 統合は管理者だけ（アーカイブ中は不可） */
  canMerge = computed(() => this.showMerge() && this.role() === 'admin' && !this.projectArchived());
  mergeOpen = signal(false);

  /** 復元は、管理者と、提起した本人（メンバー） */
  canRestore = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.reporterId === this.myUid);
  });

  toolDenied = computed(() => [
    ...(this.canEdit() ? [] : ['edit.denied']),
    ...(this.canSetPriority() ? [] : ['priorityEdit.denied']),
    ...(this.canDelete() ? [] : ['delete.denied']),
    ...(this.showMerge() && !this.canMerge() ? ['merge.denied'] : []),
    ...(this.showCauseButton() && !this.canEditCause() ? ['causeEdit.denied'] : []),
  ]);
  overdue = computed(() => this.issue()!.dueAt.toMillis() < this.clock.now());
  dueText = computed(() => {
    const r = remainingOf(this.issue()!.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  });
  dueLabel = computed(() => formatDateTime(this.issue()!.dueAt.toDate(), this.tz(), this.i18n.lang()));
  transitions = computed(() => {
    const i = this.issue();
    const r = this.role();
    return i && r ? availableTransitions(i, r, this.myUid) : [];
  });
  /** 押せないボタンがあるときの理由（重複なし） */
  deniedReasons = computed(() => [
    ...new Set(this.transitions().filter((a) => !a.allowed).map((a) => 'workflow.denied.' + a.t.who)),
  ]);
  /** 却下か差し戻しのボタンが並ぶときだけ、違いの説明を出す */
  showRejectHelp = computed(() => this.transitions().some((a) => a.t.key === 'reject' || a.t.key === 'sendBack'));

  async ngOnInit() {
    // 見張りを先に始めて、役割などの読み込みと並行して届くようにする
    this.watch();
    await this.load();
  }

  /** 課題と経緯は見張る。他の人の変更も、届くたびに画面に出る */
  private watch() {
    this.stops.push(
      this.issueService.watchIssue(
        this.pid, this.iid,
        (issue) => {
          this.issue.set(issue);
          this.issueReady.set(true);
        },
        (e) => {
          this.issue.set(null);
          this.issueReady.set(true);
          this.onWatchError(e);
        },
      ),
      this.issueService.watchTimeline(this.pid, this.iid, (items) => this.timeline.set(items), (e) => console.error(e)),
      this.issueService.watchRelatedTo(this.pid, this.iid, (list) => this.preventions.set(list), (e) => console.error(e)),
      this.issueService.watchLinks(this.pid, this.iid, (rels) => {
        this.relations.set(rels);
        this.syncLinked(rels);
      }, (e) => console.error(e)),
    );
  }

  /** 役割とメンバーは見張る。プロジェクト（ラベル・アーカイブ）は開いたときに1回読む */
  async load() {
    try {
      // メンバーでなければ、ここでルールに止められて例外になる
      this.role.set(await this.ps.myRole(this.pid, this.myUid));
      // どちらも、最初の1回が届くまで待つ
      await Promise.all([this.watchProject(), this.watchMembers()]);
    } catch (e) {
      console.error(e);
      this.issue.set(null);
    } finally {
      this.metaLoading.set(false);
    }
  }

  /** プロジェクトを見張る。設定やラベルを変えたら、開いたままでも反映する。最初の1回が届いたら知らせる */
  private watchProject() {
    return new Promise<void>((resolve, reject) => {
      this.stops.push(this.ps.watchProject(
        this.pid,
        (project) => {
          this.applyProject(project);
          resolve(); // 2回目以降に呼ばれても何も起きない
        },
        (e) => {
          this.onWatchError(e);
          reject(e);
        },
      ));
    });
  }

  private applyProject(project: Project | null) {
    this.projectLabels.set(project?.labels ?? []);
    this.projectArchived.set(project?.archived ?? false);
    this.staleDays.set(project?.settings?.staleDays ?? DEFAULT_SETTINGS.staleDays);
    this.projectName.set(project?.name ?? '');
    this.formerMembers = project?.formerMembers ?? {};
  }

  /** メンバーを見張る。最初の1回が届いたら、待っている load() に知らせる */
  private watchMembers() {
    return new Promise<void>((resolve, reject) => {
      this.stops.push(this.ps.watchMembers(
        this.pid,
        (members) => {
          this.applyMembers(members);
          resolve();
        },
        (e) => {
          this.onWatchError(e);
          reject(e);
        },
      ));
    });
  }

  /** 自分の役割も、メンバー一覧から取り直す */
  private applyMembers(members: Member[]) {
    const me = members.find((m) => m.uid === this.myUid);
    if (!me) {
      this.lostAccess();
      return;
    }
    this.members.set(members);
    this.role.set(me.role);
  }

  /** 開き終わったあとに読めなくなった＝メンバーから外された（開く前なら「見つからない」のまま） */
  private onWatchError(e: FirestoreError) {
    console.error(e);
    if (e.code === 'permission-denied' && !this.metaLoading()) this.lostAccess();
  }

  /** 外されたら、ホームへ戻して知らせる（「戻る」で見られない画面に戻らないよう、履歴を置き換える） */
  private lostAccess() {
    // 見張りが複数あるので、外されたときは知らせが何回か来うる。止めたあと（stops が空）なら何もしない
    if (!this.stops.length) return;
    this.stops.forEach((stop) => stop());
    this.stops = [];
    this.router.navigate(['/'], { replaceUrl: true, state: { removedFrom: this.projectName() } });
  }

  click(t: Transition) {
    this.actionConflict.set(null);
    if (t.needs === 'none') {
      this.applyNow(t);
      return;
    }
    this.base.set(this.issue());
    this.active.set(t);
  }

  openEdit() {
    this.base.set(this.issue());
    this.editing.set(true);
  }

  openMerge() {
    this.base.set(this.issue());
    this.mergeOpen.set(true);
  }

  /** 入力が要らない変更（対応を始める・再開）は、押したらすぐ保存する */
  private async applyNow(t: Transition) {
    this.busy.set(true);
    try {
      await this.issueService.changeStatus(this.pid, this.issue()!, t, EMPTY_STATUS_PAYLOAD, this.myUid, this.tz());
    } catch (e) {
      if (e instanceof ConflictError) {
        // 画面は見張りで最新になっているので、ボタンもすでに最新の状態に合っている
        this.actionConflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async onStatusDone() {
    this.active.set(null);

  }

  async sendComment() {
    const body = this.comment.trim();
    if (!body) return;
    this.busy.set(true);
    try {
      await this.issueService.addComment(this.pid, this.iid, body, this.myUid, this.tz());
      this.comment = '';
    } catch (e) {
      console.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  // ---- 関連課題 ----
  /** 相手の課題を1件ずつ見張る（増えたら始め、外したらやめる）。読めなければ null */
  private syncLinked(rels: IssueRelation[]) {
    const keys = new Set(rels.map((r) => `${r.pid}/${r.iid}`));
    for (const [k, stop] of this.linkStops) {
      if (!keys.has(k)) {
        stop();
        this.linkStops.delete(k);
      }
    }
    for (const r of rels) {
      const k = `${r.pid}/${r.iid}`;
      if (this.linkStops.has(k)) continue;
      this.linkStops.set(k, this.issueService.watchIssue(r.pid, r.iid,
        (issue) => this.linked.update((m) => ({ ...m, [k]: issue })),
        () => this.linked.update((m) => ({ ...m, [k]: null }))));
      if (r.pid !== this.pid) this.loadProjectName(r.pid);
    }
  }

  /** ほかのプロジェクトの名前を読む（メンバーでなければ読めないので、出さない） */
  private async loadProjectName(pid: string) {
    if (this.projectNames()[pid]) return;
    try {
      const p = await this.ps.get(pid);
      if (p) this.projectNames.update((m) => ({ ...m, [pid]: p.name }));
    } catch {
      // 読めないプロジェクト：名前は出さず、課題も「閲覧できない課題」になる
    }
  }

  linkedIssue(r: IssueRelation) {
    return this.linked()[`${r.pid}/${r.iid}`];
  }

  /** 外せるのは、こちらから付けたもの。相手から付けられたものは、同じプロジェクトのときだけ */
  canUnlink(r: IssueRelation) {
    return this.canLink() && (r.dir === 'out' || r.pid === this.pid);
  }

  async unlink(r: IssueRelation) {
    this.busy.set(true);
    this.linkError.set('');
    try {
      await this.issueService.removeLink(this.pid, this.iid, this.issue()!.number, r,
        this.linkedIssue(r)?.number ?? null, this.myUid, this.tz());
    } catch (e) {
      console.error(e);
      this.linkError.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 経緯に出す相手：同じプロジェクトなら番号、ほかのプロジェクトは、今読めるときだけ名前つき */
  private linkTarget(pid: string, number: number | null) {
    if (number === null) return this.i18n.t('links.unreadable');
    if (pid === this.pid) return '#' + number;
    const name = this.projectNames()[pid];
    return name ? `${name} #${number}` : this.i18n.t('links.unreadable');
  }

  memberName(uid: string) {
    const m = this.members().find((x) => x.uid === uid);
    if (m) return m.displayName;
    const former = this.formerMembers[uid];
    return former ? this.i18n.t('project.former', { name: former }) : '—';
  }

  who(latest: Issue) {
    return conflictWho(latest, this.members(), this.myUid);
  }

  eventText(item: TimelineItem) {
    const name = this.memberName(item.by);
    if (item.type === 'link' && item.link) {
      const l = item.link;
      return this.i18n.t('detail.events.link.' + l.action, {
        name, kind: this.i18n.t('links.groups.' + linkGroupOf(l.kind, l.dir)), target: this.linkTarget(l.pid, l.number),
      });
    }
    if (item.type === 'created') return this.i18n.t('detail.events.created', { name });
    if (item.type === 'imported') return this.i18n.t('detail.events.imported', { name });
    if (item.type === 'merge' && item.merged) {
      return this.i18n.t('detail.events.merge', { name, n: String(item.merged.number) });
    }
    if (item.type === 'edit') {
      const fields = (item.fields ?? [])
        .map((f) => this.i18n.t('issue.' + (FIELD_LABEL_KEYS[f] ?? f)))
        .join(this.i18n.lang() === 'ja' ? '・' : ', ');
      return this.i18n.t('detail.events.edit', { name, fields });
    }
    if (item.type === 'priority') {
      const label = (p: Level | null | undefined) => p
        ? this.i18n.t('priority.' + p)
        : this.i18n.t('priorityEdit.autoLabel', { p: this.i18n.t('priority.' + item.autoPriority) });
      return this.i18n.t('detail.events.priority', {
        name, from: label(item.fromPriority), to: label(item.toPriority),
      });
    }
    return this.i18n.t('detail.events.status', {
      name,
      from: this.i18n.t('status.' + item.from),
      to: this.i18n.t('status.' + item.to),
    });
  }


  /** 書いた人の現地時間で表示し、見ている人と違えば基準を併記する */
  when(item: TimelineItem) {
    const writerTz = item.tz ?? this.tz();
    const text = formatDateTime(item.at.toDate(), writerTz, this.i18n.lang());
    return writerTz === this.tz() ? text : `${text}（${writerTz}）`;
  }

  fmt(ts: { toDate(): Date }) {
    return formatDateTime(ts.toDate(), this.tz(), this.i18n.lang());
  }

  /** 'YYYY-MM-DD' を「2026年10月13日(火)」のように出す（暦の日付なので、タイムゾーンで変えない） */
  dayLabel(key: string) {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat(this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  
  async onEdited() {
    this.editing.set(false);

  }

  openPriority() {
    this.prioBase.set(this.issue());
    this.prioConflict.set(null);
    this.prioChoice.set(null);
    this.prioReason = '';
    this.error.set('');
    this.prioPanel.set(true);
  }

  async confirmPriority() {
    const choice = this.prioChoice();
    if (!choice) return;
    const value = choice === 'auto' ? null : choice;
    this.busy.set(true);
    this.error.set('');
    this.prioConflict.set(null);
    try {
      await this.issueService.setPriority(
        this.pid, this.prioBase()!, value, this.autoPriority(), this.prioReason.trim(), this.myUid, this.tz(),
      );
      this.prioPanel.set(false);
    } catch (e) {
      if (e instanceof ConflictError) {
        const blocked = e.latest.status === 'closed' || e.latest.status === 'rejected';
        if (!blocked) this.prioBase.set(e.latest);
        this.prioConflict.set({ latest: e.latest, blocked });
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  openCause() {
    const i = this.issue()!;
    this.causeBase.set(i);
    this.causeText = i.cause ?? '';
    this.counterText = i.countermeasure ?? '';
    this.causeCat.set(i.causeCategory ?? null);
    this.causeConflict.set(null);
    this.error.set('');
    this.causePanel.set(true);
  }

  async confirmCause() {
    this.busy.set(true);
    this.error.set('');
    this.causeConflict.set(null);
    try {
      await this.issueService.updateCause(this.pid, this.causeBase()!, {
        cause: this.causeText.trim(), countermeasure: this.counterText.trim(), causeCategory: this.causeCat(),
      }, this.myUid, this.tz());
      this.causePanel.set(false);
    } catch (e) {
      if (e instanceof ConflictError) {
        // 対応中・保留のままなら、最新を土台にもう一度保存できる（入力はそのまま残す）
        const blocked = e.latest.status !== 'in_progress' && e.latest.status !== 'on_hold';
        if (!blocked) this.causeBase.set(e.latest);
        this.causeConflict.set({ latest: e.latest, blocked });
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  openDelete() {
    this.delBase.set(this.issue());
    this.delConflict.set(null);
    this.delReason = '';
    this.error.set('');
    this.delPanel.set(true);
  }

  /** 削除したら、リストへ戻って「元に戻す」を出す */
  async confirmDelete() {
    const base = this.delBase()!;
    this.busy.set(true);
    this.error.set('');
    this.delConflict.set(null);
    try {
      await this.issueService.deleteIssue(this.pid, base, this.delReason.trim(), this.myUid, this.tz());
      this.router.navigate(['/p', this.pid, 'list'], { state: { deleted: { iid: this.iid, number: base.number } } });
    } catch (e) {
      if (e instanceof ConflictError) {
        this.delBase.set(e.latest);
        this.delConflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async restore() {
    this.busy.set(true);
    this.error.set('');
    try {
      // 戻ったことは見張りで届くので、ここでは何もしない
      const admins = this.role() === 'admin' ? [] : this.members().filter((m) => m.role === 'admin').map((m) => m.uid);
      await this.issueService.restoreIssue(this.pid, this.iid, this.myUid, this.tz(), admins);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  /** アプリの中で前の画面があればそこへ（見ていた月や絞り込みごと戻る）。なければプロジェクトへ */
  back() {
    const navigationId = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    if (navigationId > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/p', this.pid]);
    }
  }
  // ---- コメントの編集・削除 ----
  startEdit(item: TimelineItem) {
    this.editingId.set(item.id);
    this.editBody = item.body ?? '';
  }

  async saveEdit(item: TimelineItem) {
    const body = this.editBody.trim();
    if (!body) return;
    if (body === item.body) {
      // 何も変えていなければ、保存せずに閉じる（「編集済み」を付けない）
      this.editingId.set(null);
      return;
    }
    this.busy.set(true);
    try {
      await this.issueService.updateComment(this.pid, this.iid, item.id, body);
      this.editingId.set(null);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async askDelete(item: TimelineItem) {
    if (!confirm(this.i18n.t('comment.deleteConfirm'))) return;
    this.busy.set(true);
    try {
      await this.issueService.deleteComment(this.pid, this.iid, item.id, this.myUid);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}