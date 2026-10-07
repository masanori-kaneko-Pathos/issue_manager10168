import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../../core/firebase';
import { AuthService } from '../../../core/auth.service';
import { IssueEdits, IssueService } from '../../../core/issue.service';
import { ISSUE_TYPES, Issue, IssueType, Label, Level, Member } from '../../../core/models';
import { LabelPicker } from '../../../shared/label-picker';
import { endOfDayIn, formatDateTime, parseLocalInput, toLocalInput } from '../../../core/time';
import { I18nService, TPipe } from '../../../i18n/i18n';

/** 並び順を無視して、同じ id の組み合わせかを比べる */
function sameIds(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

@Component({
  selector: 'app-issue-edit',
  imports: [FormsModule, TPipe, LabelPicker],
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
      <h2>{{ 'edit.title' | t }}</h2>
      <div class="field">
        <span>{{ 'issue.labelIds' | t }}</span>
        <app-label-picker [labels]="labels()" [(selected)]="labelIds" />
      </div>
      <label class="field">{{ 'issue.title' | t }}
        <input [(ngModel)]="title" maxlength="200" />
      </label>

      <fieldset>
        <legend>{{ 'issue.type' | t }}</legend>
        <div class="chips">
          @for (t of types; track t) {
            <button type="button" [class.on]="type() === t" (click)="type.set(t)">{{ 'issueTypes.' + t | t }}</button>
          }
        </div>
      </fieldset>

      <fieldset>
        <legend>{{ 'issue.importance' | t }}</legend>
        <div class="chips">
          @for (l of levels; track l) {
            <button type="button" [class.on]="importance() === l" (click)="importance.set(l)">
              {{ 'importance.' + l | t }}</button>
          }
        </div>
      </fieldset>

      <fieldset>
        <legend>{{ 'issue.due' | t }}</legend>
        <div class="chips">
          @for (p of duePresets; track p.key) {
            <button type="button" (click)="pickPreset(p.days)">{{ 'duePresets.' + p.key | t }}</button>
          }
        </div>
        <input type="datetime-local" [ngModel]="dueInput" (ngModelChange)="onDueInput($event)" />
        @if (dueAt()) { <p class="help">{{ dueLabel() }}（{{ tz() }}）</p> }
      </fieldset>

      <fieldset>
        <legend>{{ 'issue.assignee' | t }}</legend>
        <div class="chips">
          @for (m of assignable(); track m.uid) {
            <button type="button" [class.on]="assigneeId() === m.uid" (click)="assigneeId.set(m.uid)">
              {{ m.displayName }}</button>
          }
        </div>
      </fieldset>

      <label class="field">{{ 'issue.doneCriteria' | t }}
        <textarea [(ngModel)]="doneCriteria" rows="2"></textarea>
      </label>

      <label class="field">{{ 'issue.description' | t }}
        <textarea [(ngModel)]="description" rows="5"></textarea>
      </label>

      @if (needsReason()) {
        <label class="field reason">{{ 'edit.reason' | t }}
          <textarea [(ngModel)]="reason" rows="2" [placeholder]="'edit.reasonHint' | t"></textarea>
        </label>
      }

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy()" (click)="save()">{{ 'edit.save' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(600px, 100%); max-height: 90vh; overflow: auto;
      border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    @media (max-width: 600px) {
      .dialog { height: 100%; max-height: none; border-radius: 0; }
    }
    h2 { font-size: 18px; margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    fieldset { border: none; padding: 0; margin: 0; }
    legend { font-size: 14px; font-weight: bold; }
    input, textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    input { min-height: 44px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0; }
    .chips button { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0; font-weight: normal; }
    .reason { background: var(--warning-bg); padding: 8px; border-radius: 8px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
  `,
})
export class IssueEdit implements OnInit {
  issue = input.required<Issue>();
  members = input.required<Member[]>();
  pid = input.required<string>();
  labels = input<Label[]>([]);
  saved = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);

  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly duePresets = [
    { key: 'today', days: 0 },
    { key: 'tomorrow', days: 1 },
    { key: 'in3', days: 3 },
    { key: 'in7', days: 7 },
  ];

  type = signal<IssueType>('task');
  importance = signal<Level>('mid');
  dueAt = signal<Date | null>(null);
  assigneeId = signal('');
  labelIds = signal<string[]>([]);
  busy = signal(false);
  error = signal('');
  title = '';
  dueInput = '';
  doneCriteria = '';
  description = '';
  reason = '';

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));
  dueLabel = computed(() => {
    const d = this.dueAt();
    return d ? formatDateTime(d, this.tz(), this.i18n.lang()) : '';
  });
  dueChanged = computed(() => this.dueAt()?.getTime() !== this.issue().dueAt.toMillis());
  /** 期限か担当者を変えたときだけ、理由が必須 */
  needsReason = computed(() => this.dueChanged() || this.assigneeId() !== this.issue().assigneeId);

  ngOnInit() {
    const i = this.issue();
    this.title = i.title;
    this.type.set(i.type);
    this.importance.set(i.importance);
    this.dueAt.set(i.dueAt.toDate());
    this.dueInput = toLocalInput(i.dueAt.toDate(), this.tz());
    this.assigneeId.set(i.assigneeId);
    this.labelIds.set(i.labelIds ?? []);
    this.doneCriteria = i.doneCriteria;
    this.description = i.description;
  }

  pickPreset(days: number) {
    const d = endOfDayIn(days, this.tz());
    this.dueAt.set(d);
    this.dueInput = toLocalInput(d, this.tz());
  }

  onDueInput(value: string) {
    this.dueInput = value;
    this.dueAt.set(parseLocalInput(value, this.tz()));
  }

  async save() {
    const i = this.issue();
    const title = this.title.trim();
    const doneCriteria = this.doneCriteria.trim();
    const due = this.dueAt();

    if (!title || !doneCriteria || !due) { this.error.set('edit.required'); return; }
    if (this.dueChanged() && due.getTime() <= Date.now()) { this.error.set('issueNew.duePast'); return; }
    if (this.needsReason() && !this.reason.trim()) { this.error.set('edit.reasonRequired'); return; }

    // 変えた項目だけを集める
    const edits: IssueEdits = {};
    if (title !== i.title) edits.title = title;
    if (this.type() !== i.type) edits.type = this.type();
    if (this.importance() !== i.importance) edits.importance = this.importance();
    if (this.dueChanged()) edits.dueAt = due;
    if (this.assigneeId() !== i.assigneeId) edits.assigneeId = this.assigneeId();
    if (doneCriteria !== i.doneCriteria) edits.doneCriteria = doneCriteria;
    if (this.description !== i.description) edits.description = this.description;
    if (!sameIds(this.labelIds(), i.labelIds ?? [])) edits.labelIds = this.labelIds();

    if (Object.keys(edits).length === 0) { this.cancel.emit(); return; }

    this.busy.set(true);
    this.error.set('');
    try {
      await this.issueService.updateIssue(
        this.pid(), i, edits, this.reason.trim(), auth.currentUser!.uid, this.tz(),
      );
      this.saved.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}