import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth.service';
import { Clock } from '../../core/clock';
import { ProjectService } from '../../core/project.service';
import { EMPTY_STATUS_PAYLOAD, IssueService } from '../../core/issue.service';
import { Issue, Label, Level, Member, Role, TimelineItem, labelsOf } from '../../core/models';
import { StatusDialog } from '../../shared/status-dialog';
import { LabelChip } from '../../shared/label-chip';
import { IssueEdit } from './issue-edit/issue-edit';
import { HelpTip } from '../../shared/help-tip';
import { priorityOf } from '../../core/priority';
import { formatDateTime, remainingOf } from '../../core/time';
import { Transition, availableTransitions } from '../../core/workflow';
import { I18nService, TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-issue-detail',
  imports: [FormsModule, RouterLink, TPipe, IssueEdit, HelpTip, LabelChip, StatusDialog],
  template: `
    <header class="bar"><button type="button" class="link" (click)="back()">{{ 'common.back' | t }}</button></header>
    <main>
      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!issue()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        @let i = issue()!;
        <p class="num">#{{ i.number }} · {{ 'issueTypes.' + i.type | t }}</p>
        <h1>{{ i.title }}</h1>
        <div class="badges">
          <span class="status" [attr.data-s]="i.status">{{ 'status.' + i.status | t }}</span>
                    <span class="prio" [attr.data-p]="priority()">
            {{ 'issue.priority' | t }}：{{ 'priority.' + priority() | t }}
            @if (i.priorityOverride) {
              {{ 'priorityEdit.manual' | t: { auto: i18n.t('priority.' + autoPriority()) } }}
            }
          </span>
          @if (i.status !== 'closed' && i.status !== 'rejected') {
            <span class="due" [class.overdue]="overdue()">{{ dueText() }}</span>
          }
        </div>
        @if (i.statusReason && (i.status === 'on_hold' || i.status === 'rejected')) {
          <p class="reason">{{ i.statusReason }}</p>
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
          @if (i.cause) {
            <dt>{{ 'workflow.cause' | t }}</dt><dd class="pre">{{ i.cause }}</dd>
            <dt>{{ 'workflow.countermeasure' | t }}</dt><dd class="pre">{{ i.countermeasure }}</dd>
            <dt>{{ 'workflow.causeCategory' | t }}</dt><dd>{{ 'causeCategories.' + i.causeCategory | t }}</dd>
          }
          @if (i.effect) {
            <dt>{{ 'workflow.effect' | t }}</dt><dd>{{ 'workflow.effectOpts.' + i.effect | t }}</dd>
            @if (i.learning) { <dt>{{ 'workflow.learning' | t }}</dt><dd class="pre">{{ i.learning }}</dd> }
          }
        </dl>

                <section class="tools">
          <button type="button" [disabled]="!canEdit()" (click)="editing.set(true)">{{ 'edit.open' | t }}</button>
          <button type="button" [disabled]="!canSetPriority()" (click)="openPriority()">
            {{ 'priorityEdit.open' | t }}</button>
          @if (toolDenied().length) { <app-help-tip kind="denied" [keys]="toolDenied()" /> }
        </section>

        @if (prioPanel()) {
          <section class="panel">
            <h2>{{ 'priorityEdit.open' | t }}</h2>
            <div class="chips">
              @for (l of levels; track l) {
                <button type="button" [class.on]="prioChoice() === l" (click)="prioChoice.set(l)">
                  {{ 'priority.' + l | t }}</button>
              }
              @if (i.priorityOverride) {
                <button type="button" [class.on]="prioChoice() === 'auto'" (click)="prioChoice.set('auto')">
                  {{ 'priorityEdit.auto' | t }}</button>
              }
            </div>
            <label class="field">{{ 'priorityEdit.reason' | t }}
              <textarea [(ngModel)]="prioReason" rows="2" [placeholder]="'priorityEdit.reasonHint' | t"></textarea>
            </label>
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            <div class="row">
              <button type="button" class="link" (click)="prioPanel.set(false)">{{ 'workflow.cancel' | t }}</button>
              <button type="button" class="primary" [disabled]="busy() || !prioChoice() || !prioReason.trim()"
                (click)="confirmPriority()">{{ 'workflow.confirm' | t }}</button>
            </div>
          </section>
        }

        @if (editing()) {
          <app-issue-edit [issue]="i" [members]="members()" [pid]="pid" [labels]="projectLabels()"
            (saved)="onEdited()" (cancel)="editing.set(false)" />
        }

        <section class="actions">
          @for (a of transitions(); track a.t.key) {
            <button type="button" [disabled]="!a.allowed || busy()" [class.on]="active()?.key === a.t.key"
              (click)="click(a.t)">{{ 'workflow.' + a.t.key | t }}</button>
          }
          @if (deniedReasons().length) { <app-help-tip kind="denied" [keys]="deniedReasons()" /> }
        </section>

               @if (active(); as t) {
          <app-status-dialog [issue]="i" [transition]="t" [pid]="pid"
            (done)="onStatusDone()" (cancel)="active.set(null)" />
        }

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
                  @if (item.kind === 'comment' && !item.deleted && editingId() !== item.id && !projectArchived()) {
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
          <div class="comment-box">
            <textarea [(ngModel)]="comment" rows="3" [placeholder]="'detail.commentPlaceholder' | t"></textarea>
            <button type="button" class="primary" [disabled]="busy() || !comment.trim()" (click)="sendComment()">
              {{ 'detail.send' | t }}</button>
          </div>
        </section>
      }
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
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
    .chips button { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
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

  issue = signal<Issue | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  timeline = signal<TimelineItem[]>([]);
  projectLabels = signal<Label[]>([]);
  issueLabels = computed(() => labelsOf(this.issue()?.labelIds, this.projectLabels()));
  loading = signal(true);
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

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  priority = computed(() => priorityOf(this.issue()!, this.clock.now()));
  autoPriority = computed(() => priorityOf({ ...this.issue()!, priorityOverride: null }, this.clock.now()));
  canEdit = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || i.status === 'closed') return false;
    if (r === 'admin') return true;
    return r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid);
  });
  canSetPriority = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || i.status === 'closed' || i.status === 'rejected') return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });
  toolDenied = computed(() => [
    ...(this.canEdit() ? [] : ['edit.denied']),
    ...(this.canSetPriority() ? [] : ['priorityEdit.denied']),
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

  async ngOnInit() {
    await this.load();
  }

  async load() {
    try {
      this.role.set(await this.ps.myRole(this.pid, this.myUid));
      const [issue, members, timeline, project] = await Promise.all([
        this.issueService.get(this.pid, this.iid),
        this.ps.listMembers(this.pid),
        this.issueService.timeline(this.pid, this.iid),
        this.ps.get(this.pid),
      ]);
      this.projectLabels.set(project?.labels ?? []);
      this.projectArchived.set(project?.archived ?? false);
      this.issue.set(issue);
      this.members.set(members);
      this.timeline.set(timeline);
    } catch (e) {
      console.error(e);
      this.issue.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  click(t: Transition) {
    if (t.needs === 'none') {
      this.applyNow(t);
      return;
    }
    this.active.set(t);
  }

  /** 入力が要らない変更（対応を始める・再開）は、押したらすぐ保存する */
  private async applyNow(t: Transition) {
    this.busy.set(true);
    try {
      await this.issueService.changeStatus(this.pid, this.issue()!, t, EMPTY_STATUS_PAYLOAD, this.myUid, this.tz());
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async onStatusDone() {
    this.active.set(null);
    await this.load();
  }

  async sendComment() {
    const body = this.comment.trim();
    if (!body) return;
    this.busy.set(true);
    try {
      await this.issueService.addComment(this.pid, this.iid, body, this.myUid, this.tz());
      this.comment = '';
      this.timeline.set(await this.issueService.timeline(this.pid, this.iid));
    } catch (e) {
      console.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  memberName(uid: string) {
    return this.members().find((m) => m.uid === uid)?.displayName ?? '—';
  }

  eventText(item: TimelineItem) {
    const name = this.memberName(item.by);
    if (item.type === 'created') return this.i18n.t('detail.events.created', { name });
    if (item.type === 'edit') {
      const fields = (item.fields ?? []).map((f) => this.i18n.t('issue.' + f)).join('・');
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

  async onEdited() {
    this.editing.set(false);
    await this.load();
  }

  openPriority() {
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
    try {
      await this.issueService.setPriority(
        this.pid, this.issue()!, value, this.autoPriority(), this.prioReason.trim(), this.myUid, this.tz(),
      );
      this.prioPanel.set(false);
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
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
        this.timeline.set(await this.issueService.timeline(this.pid, this.iid));
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
        this.timeline.set(await this.issueService.timeline(this.pid, this.iid));
      } catch (e) {
        console.error(e);
        this.error.set('common.saveError');
      } finally {
        this.busy.set(false);
      }
    }
}