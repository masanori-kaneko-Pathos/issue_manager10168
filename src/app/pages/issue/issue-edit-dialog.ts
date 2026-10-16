import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ConflictError, IssueEdits, IssueService, conflictWho } from '../../core/issue/issue.service';
import { ISSUE_TYPES, Issue, IssueType, Label, Level, Member } from '../../core/models';
import { LabelPicker } from '../../shared/label-picker';
import { dateKey, endOfDayIn, formatDateTime, parseLocalInput, toLocalInput } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { MemberSelect } from '../../shared/member-select';

/** 並び順を無視して、同じ id の組み合わせかを比べる */
function sameIds(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

@Component({
  selector: 'app-issue-edit-dialog',
  imports: [FormsModule, TPipe, LabelPicker, MemberSelect],
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
        @if (dueChanged() && isPastDue()) {
          <p class="warn" role="alert">{{ 'dueDialog.pastWarning' | t }}</p>
        }
      </fieldset>

      <div class="field">
        <label for="e-assignee">{{ 'issue.assignee' | t }}</label>
        <app-member-select selectId="e-assignee" [members]="assignable()" [value]="assigneeId()"
          (picked)="assigneeId.set($event)" />
      </div>

      <label class="field">{{ 'issue.doneCriteria' | t }}
        <textarea [(ngModel)]="doneCriteria" rows="2"></textarea>
      </label>

      <label class="field">{{ 'issue.description' | t }}
        <textarea [(ngModel)]="description" rows="5"></textarea>
      </label>

      <label class="field">{{ 'issue.occurredOn' | t }}
        <input type="date" [(ngModel)]="occurredOn" [max]="today()" />
      </label>

      <label class="field">{{ 'issue.impact' | t }}
        <input [(ngModel)]="impact" maxlength="200" [placeholder]="'issueNew.impactPlaceholder' | t" />
      </label>

      @if (needsReason()) {
        <label class="field reason">{{ 'edit.reason' | t }}
          <textarea [(ngModel)]="reason" rows="2" [placeholder]="'edit.reasonHint' | t"></textarea>
        </label>
      }

      @if (conflict(); as c) {
        @let w = who(c);
        <div class="conflict" role="alert">
          <p>{{ w.key | t: w.params }}</p>
          @if (c.status === 'closed') {
            <p>{{ 'conflict.closed' | t }}</p>
          } @else {
            <p>{{ 'conflict.editHint' | t }}</p>
            <button type="button" class="pull" (click)="pullLatest()">{{ 'conflict.pull' | t }}</button>
          }
        </div>
      }
      @if (info()) {
        <div class="pulled" role="status">
          <p>{{ info() | t }}</p>
          @if (bothChanged().length) { <p>{{ 'conflict.both' | t: { fields: bothLabels() } }}</p> }
        </div>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [class.danger]="dueChanged() && isPastDue()" [disabled]="busy() || !!conflict()"
          (click)="save()">{{ (dueChanged() && isPastDue() ? 'dueDialog.confirmPast' : 'edit.save') | t }}</button>
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
    .primary.danger { background: var(--danger); }
    .error { color: var(--danger-text); }
    .conflict, .pulled { padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: normal; }
    .conflict { background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .pulled { background: var(--surface-alt); }
    .conflict p, .pulled p { margin: 0 0 6px; }
    .conflict p:last-child, .pulled p:last-child { margin-bottom: 0; }
    .pull { min-height: 44px; padding: 0 16px; border: 1px solid var(--primary); color: var(--primary);
      background: var(--surface); border-radius: 8px; font-size: 14px; }
    .warn { margin: 4px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: normal;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
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
  occurredOn = '';
  impact = '';

    /** 比べる相手（開いた時点の課題。取り込んだあとは最新） */
  private base = signal<Issue | null>(null);
  /** 保存しようとしたら、ほかの人が先に更新していた（中身は最新の課題） */
  conflict = signal<Issue | null>(null);
  /** 自分もほかの人も変えていた欄（翻訳キー issue.〇〇 の〇〇） */
  bothChanged = signal<string[]>([]);
  info = signal('');
  bothLabels = computed(() =>
    this.bothChanged().map((k) => this.i18n.t('issue.' + k)).join(this.i18n.lang() === 'ja' ? '・' : ', '));

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  today = computed(() => dateKey(new Date(), this.tz()));
  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));
  dueLabel = computed(() => {
    const d = this.dueAt();
    return d ? formatDateTime(d, this.tz(), this.i18n.lang()) : '';
  });
  dueChanged = computed(() => this.dueAt()?.getTime() !== this.base()?.dueAt.toMillis());

  isPastDue = computed(() => {
    const d = this.dueAt();
    return !!d && d.getTime() <= Date.now();
  });
  /** 期限か担当者を変えたときだけ、理由が必須 */
  needsReason = computed(() => this.dueChanged() || this.assigneeId() !== this.base()?.assigneeId);

  ngOnInit() {
    const i = this.issue();
    this.base.set(i);
    this.title = i.title;
    this.type.set(i.type);
    this.importance.set(i.importance);
    this.dueAt.set(i.dueAt.toDate());
    this.dueInput = toLocalInput(i.dueAt.toDate(), this.tz());
    this.assigneeId.set(i.assigneeId);
    this.labelIds.set(i.labelIds ?? []);
    this.doneCriteria = i.doneCriteria;
    this.description = i.description;
    this.occurredOn = i.occurredOn ?? '';
    this.impact = i.impact ?? '';
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
    const i = this.base()!;
    const title = this.title.trim();
    const doneCriteria = this.doneCriteria.trim();
    const due = this.dueAt();

    if (!title || !doneCriteria || !due) { this.error.set('edit.required'); return; }
    if (this.needsReason() && !this.reason.trim()) { this.error.set('edit.reasonRequired'); return; }

    // 変えた項目だけを集める
    const edits: IssueEdits = {};
    if (title !== i.title) edits.title = title;
    if (this.type() !== i.type) edits.type = this.type();
    if (this.importance() !== i.importance) edits.importance = this.importance();
    if (this.assigneeId() !== i.assigneeId) edits.assigneeId = this.assigneeId();
    if (this.dueChanged()) edits.dueAt = due; 
    if (doneCriteria !== i.doneCriteria) edits.doneCriteria = doneCriteria;
    if (this.description !== i.description) edits.description = this.description;
    if (!sameIds(this.labelIds(), i.labelIds ?? [])) edits.labelIds = this.labelIds();
    const occurredOn = this.occurredOn || null;
    if (occurredOn !== (i.occurredOn ?? null)) edits.occurredOn = occurredOn;
    const impact = this.impact.trim();
    if (impact !== (i.impact ?? '')) edits.impact = impact;

    if (Object.keys(edits).length === 0) { this.cancel.emit(); return; }

    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      await this.issueService.updateIssue(
        this.pid(), i, edits, this.reason.trim(), auth.currentUser!.uid, this.tz(),
      );
      this.saved.emit();
    } catch (e) {
      if (e instanceof ConflictError) {
        this.conflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** 最新の内容を取り込む。自分が触っていない欄は最新に、両方が変えた欄は自分の入力を残す */
  pullLatest() {
    const latest = this.conflict();
    const was = this.base();
    if (!latest || !was) return;
    const both: string[] = [];
    /** mine＝今の入力、before＝開いた時点、after＝最新 */
    const merge = <T>(key: string, mine: T, before: T, after: T, apply: (v: T) => void,
      eq: (a: T, b: T) => boolean = (a, b) => a === b) => {
      if (eq(mine, before)) apply(after);                               // 自分は触っていない → 最新に
      else if (!eq(after, before) && !eq(mine, after)) both.push(key);  // 両方が別々に変えた → 自分の入力を残す
    };
    merge('title', this.title.trim(), was.title, latest.title, (v) => (this.title = v));
    merge('type', this.type(), was.type, latest.type, (v) => this.type.set(v));
    merge('importance', this.importance(), was.importance, latest.importance, (v) => this.importance.set(v));
    merge('due', this.dueAt()?.getTime() ?? 0, was.dueAt.toMillis(), latest.dueAt.toMillis(), (v) => {
      const d = new Date(v);
      this.dueAt.set(d);
      this.dueInput = toLocalInput(d, this.tz());
    });
    merge('assignee', this.assigneeId(), was.assigneeId, latest.assigneeId, (v) => this.assigneeId.set(v));
    merge('labelIds', this.labelIds(), was.labelIds ?? [], latest.labelIds ?? [], (v) => this.labelIds.set(v), sameIds);
    merge('doneCriteria', this.doneCriteria.trim(), was.doneCriteria, latest.doneCriteria,
      (v) => (this.doneCriteria = v));
    merge('description', this.description, was.description, latest.description, (v) => (this.description = v));
    merge('occurredOn', this.occurredOn || null, was.occurredOn ?? null, latest.occurredOn ?? null,
      (v) => (this.occurredOn = v ?? ''));
    merge('impact', this.impact.trim(), was.impact ?? '', latest.impact ?? '', (v) => (this.impact = v));

    // 比べる相手を最新にする。これで次の保存は、自分が変えた欄だけを送る
    this.base.set(latest);
    this.bothChanged.set(both);
    this.conflict.set(null);
    this.info.set('conflict.pulled');
  }

  who(latest: Issue) {
    return conflictWho(latest, this.members(), auth.currentUser!.uid);
  }
}