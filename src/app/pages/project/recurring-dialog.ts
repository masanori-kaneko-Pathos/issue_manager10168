import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import {
  ISSUE_TYPES, IssueType, Label, Level, Member, RECUR_DUE_DAYS, RecurFreq, RecurringTemplate,
} from '../../core/models';
import { RecurringService } from '../../core/recurring/recurring.service';
import { nextOccurrence } from '../../core/recurring/schedule';
import { formatDateTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { LabelPicker } from '../../shared/label-picker';
import { MemberSelect } from '../../shared/member-select';

/** 定期課題を作る・直す窓（管理者だけ） */
@Component({
  selector: 'app-recurring-dialog',
  imports: [FormsModule, TPipe, LabelPicker, MemberSelect],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true"
      [attr.aria-label]="(template() ? 'recurring.dialogEdit' : 'recurring.dialogNew') | t">
      <h2>{{ (template() ? 'recurring.dialogEdit' : 'recurring.dialogNew') | t }}</h2>

      <label class="field">{{ 'issue.title' | t }}
        <input [(ngModel)]="title" maxlength="200" [placeholder]="'recurring.titleHint' | t" />
      </label>
      <fieldset>
        <legend>{{ 'issue.type' | t }}</legend>
        <div class="chips">
          @for (t of types; track t) {
            <button type="button" [class.on]="type() === t" [attr.aria-pressed]="type() === t" (click)="selectType(t)">
              {{ 'issueTypes.' + t | t }}</button>
          }
        </div>
      </fieldset>
      <fieldset>
        <legend>{{ 'issue.importance' | t }}</legend>
        <div class="chips">
          @for (l of levels; track l) {
            <button type="button" [class.on]="importance() === l" [attr.aria-pressed]="importance() === l"
              (click)="importance.set(l)">{{ 'importance.' + l | t }}</button>
          }
        </div>
      </fieldset>
      <div class="field">
        <label for="r-assignee">{{ 'issue.assignee' | t }}</label>
        <app-member-select selectId="r-assignee" [members]="members()" [value]="assigneeId()"
          (picked)="assigneeId.set($event)" />
      </div>
      <label class="field">{{ 'issue.doneCriteria' | t }}
        <textarea [(ngModel)]="doneCriteria" rows="2"></textarea>
      </label>
      <label class="field">{{ 'issue.description' | t }}
        <textarea [(ngModel)]="description" rows="4"></textarea>
      </label>
      <div class="field">
        <span>{{ 'issue.labelIds' | t }}</span>
        <app-label-picker [labels]="labels()" [(selected)]="labelIds" />
      </div>

      <fieldset>
        <legend>{{ 'recurring.when' | t }}</legend>
        <div class="chips">
          @for (f of freqs; track f) {
            <button type="button" [class.on]="freq() === f" [attr.aria-pressed]="freq() === f" (click)="freq.set(f)">
              {{ 'recurring.freq.' + f | t }}</button>
          }
        </div>
        @if (freq() === 'weekly') {
          <div class="chips">
            @for (w of week; track w) {
              <button type="button" class="wd" [class.on]="weekdays().includes(w)" [attr.aria-pressed]="weekdays().includes(w)"
                (click)="toggleWd(w)">{{ 'recurring.wd.w' + w | t }}</button>
            }
          </div>
        }
        @if (freq() === 'monthly') {
          <select [ngModel]="monthDay()" (ngModelChange)="monthDay.set(+$event)" [attr.aria-label]="'recurring.monthDay' | t">
            @for (d of days; track d) {
              <option [value]="d">{{ d === 31 ? ('recurring.endOfMonth' | t) : ('recurring.dayN' | t: { n: '' + d }) }}</option>
            }
          </select>
        }
        <div class="time">
          <span>{{ 'recurring.time' | t }}</span>
          <select [ngModel]="hour()" (ngModelChange)="hour.set(+$event)" [attr.aria-label]="'recurring.hour' | t">
            @for (h of hours; track h) { <option [value]="h">{{ h }}</option> }
          </select>
          <span>:</span>
          <select [ngModel]="minute()" (ngModelChange)="minute.set(+$event)" [attr.aria-label]="'recurring.minute' | t">
            @for (m of minutes; track m) { <option [value]="m">{{ m < 10 ? '0' + m : m }}</option> }
          </select>
        </div>
      </fieldset>

      <fieldset>
        <legend>{{ 'recurring.due' | t }}</legend>
        <div class="chips">
          @for (d of dueOpts; track d) {
            <button type="button" [class.on]="dueDays() === d" [attr.aria-pressed]="dueDays() === d" (click)="dueDays.set(d)">
              {{ 'recurring.dueN.d' + d | t }}</button>
          }
        </div>
      </fieldset>

      @if (preview(); as p) { <p class="preview">{{ 'recurring.preview' | t: { when: p } }}</p> }
      @if (freq() === 'weekly' && !weekdays().length) { <p class="warn">{{ 'recurring.needWeekday' | t }}</p> }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !ready()" (click)="save()">
          {{ 'recurring.save' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(560px, calc(100% - 32px)); max-height: 90vh;
      overflow: auto; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    @media (max-width: 600px) { .dialog { width: 100%; height: 100%; max-height: none; border-radius: 0; } }
    h2 { font-size: 18px; margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    legend { font-size: 14px; font-weight: bold; margin-bottom: 4px; }
    input, textarea, select { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    input, select { min-height: 44px; }
    select { max-width: 160px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { min-height: 40px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 20px; font-size: 14px; cursor: pointer; }
    .chips button.wd { min-width: 44px; padding: 0; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .time { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .time select { width: 80px; }
    .preview { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--surface-alt); font-size: 13px; }
    .warn { margin: 0; font-size: 13px; color: var(--warning-text); }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; cursor: pointer; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); }
  `,
})
export class RecurringDialog implements OnInit {
  pid = input.required<string>();
  /** 直すときの雛形（作るときは null） */
  template = input<RecurringTemplate | null>(null);
  /** 担当者にできる人（閲覧者を除いたメンバー） */
  members = input.required<Member[]>();
  labels = input.required<Label[]>();
  done = output<void>();
  cancel = output<void>();

  private service = inject(RecurringService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly freqs: RecurFreq[] = ['daily', 'weekly', 'monthly'];
  /** 曜日の並び（月曜はじまり。保存は 0＝日〜6＝土） */
  readonly week = [1, 2, 3, 4, 5, 6, 0];
  readonly days = [...Array.from({ length: 28 }, (_, i) => i + 1), 31];
  readonly hours = Array.from({ length: 24 }, (_, i) => i);
  readonly minutes = [0, 10, 20, 30, 40, 50];
  readonly dueOpts = RECUR_DUE_DAYS;

  title = '';
  doneCriteria = '';
  description = '';
  type = signal<IssueType | null>(null);
  importance = signal<Level | null>(null);
  assigneeId = signal(auth.currentUser!.uid);
  labelIds = signal<string[]>([]);
  freq = signal<RecurFreq>('weekly');
  weekdays = signal<number[]>([1]);
  monthDay = signal(1);
  hour = signal(9);
  minute = signal(0);
  dueDays = signal(0);
  busy = signal(false);
  error = signal('');

  /** 時刻を数えるタイムゾーン：直すときは雛形のまま、作るときは自分の */
  private tz = computed(() => this.template()?.tz ?? this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 「次は 10/27(月) 9:00 に作ります」（見ている人のタイムゾーンで） */
  preview = computed(() => {
    if (this.freq() === 'weekly' && !this.weekdays().length) return '';
    const ms = nextOccurrence({
      freq: this.freq(), weekdays: this.weekdays(), monthDay: this.monthDay(),
      time: this.hour() * 60 + this.minute(), tz: this.tz(),
    }, Date.now());
    const viewTz = this.authService.profile()?.timeZone ?? 'Asia/Tokyo';
    return formatDateTime(new Date(ms), viewTz, this.i18n.lang());
  });

  ngOnInit() {
    const t = this.template();
    if (!t) return;
    this.title = t.title;
    this.doneCriteria = t.doneCriteria;
    this.description = t.description;
    this.type.set(t.type);
    this.importance.set(t.importance);
    // 担当者がもういなければ、選び直してもらう（空のまま）
    this.assigneeId.set(this.members().some((m) => m.uid === t.assigneeId) ? t.assigneeId : '');
    this.labelIds.set(t.labelIds.filter((id) => this.labels().some((l) => l.id === id)));
    this.freq.set(t.freq);
    this.weekdays.set(t.weekdays.length ? t.weekdays : [1]);
    this.monthDay.set(t.monthDay);
    this.hour.set(Math.floor(t.time / 60));
    this.minute.set(t.time % 60);
    this.dueDays.set(t.dueDays);
  }

  /** 種別を選ぶと、完了条件と内容の雛形が入る（自分で書き換えたものは消さない。登録画面と同じ） */
  selectType(t: IssueType) {
    const prev = this.type();
    const untouched = (value: string, prefix: string) =>
      !value.trim() || (prev !== null && value === this.i18n.t(prefix + prev));
    if (untouched(this.doneCriteria, 'doneCriteria.')) this.doneCriteria = this.i18n.t('doneCriteria.' + t);
    if (untouched(this.description, 'descTemplate.')) this.description = this.i18n.t('descTemplate.' + t);
    this.type.set(t);
  }

  toggleWd(w: number) {
    this.weekdays.update((l) => (l.includes(w) ? l.filter((x) => x !== w) : [...l, w].sort()));
  }

  ready() {
    return !!(this.title.trim() && this.type() && this.importance() && this.assigneeId() && this.doneCriteria.trim()
      && (this.freq() !== 'weekly' || this.weekdays().length));
  }

  async save() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.service.save(this.pid(), this.template(), {
        title: this.title.trim(), type: this.type()!, importance: this.importance()!, assigneeId: this.assigneeId(),
        doneCriteria: this.doneCriteria.trim(), description: this.description, labelIds: this.labelIds(),
        freq: this.freq(), weekdays: this.freq() === 'weekly' ? this.weekdays() : [],
        monthDay: this.monthDay(), time: this.hour() * 60 + this.minute(), tz: this.tz(), dueDays: this.dueDays(),
      }, auth.currentUser!.uid);
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}