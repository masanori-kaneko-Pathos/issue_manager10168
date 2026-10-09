import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { IssueService } from '../core/issue/issue.service';
import { CAUSE_CATEGORIES, CauseCategory, Effect, Issue } from '../core/models';
import { Transition } from '../core/issue/workflow';
import { TPipe } from '../i18n/i18n';

@Component({
  selector: 'app-status-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
      <p class="sub">#{{ issue().number }} {{ issue().title }}</p>
      <h2>{{ 'workflow.' + transition().key | t }}</h2>

      @if (transition().needs === 'reason') {
        <label class="field">{{ 'workflow.reason' | t }}
          <textarea [(ngModel)]="reason" rows="3" [placeholder]="'workflow.reasonHint.' + transition().key | t"></textarea>
        </label>
      }
      @if (transition().needs === 'resolve') {
        <label class="field">{{ 'workflow.cause' | t }}
          <textarea [(ngModel)]="cause" rows="2"></textarea>
        </label>
        <label class="field">{{ 'workflow.countermeasure' | t }}
          <textarea [(ngModel)]="countermeasure" rows="2"></textarea>
        </label>
        <fieldset>
          <legend>{{ 'workflow.causeCategory' | t }}</legend>
          <div class="chips">
            @for (c of causeCategories; track c) {
              <button type="button" [class.on]="causeCategory() === c" (click)="causeCategory.set(c)">
                {{ 'causeCategories.' + c | t }}</button>
            }
          </div>
        </fieldset>
      }
      @if (transition().needs === 'close') {
        <fieldset>
          <legend>{{ 'workflow.effect' | t }}</legend>
          <div class="chips">
            @for (e of effects; track e) {
              <button type="button" [class.on]="effect() === e" (click)="effect.set(e)">
                {{ 'workflow.effectOpts.' + e | t }}</button>
            }
          </div>
          @if (effect() === 'no') { <p class="help">{{ 'workflow.closeHintNo' | t }}</p> }
        </fieldset>
        <label class="field">{{ 'workflow.learning' | t }}
          <textarea [(ngModel)]="learning" rows="2"></textarea>
        </label>
      }
      @if (transition().needs === 'resolve' || transition().needs === 'close') {
        <div class="criteria">
          <p class="pre">{{ issue().doneCriteria }}</p>
          <label class="check">
            <input type="checkbox" [checked]="doneMet()" (change)="doneMet.set(!doneMet())" />
            {{ 'workflow.doneCriteriaMet' | t }}
          </label>
        </div>
      }

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !canConfirm()" (click)="confirm()">
          {{ 'workflow.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(560px, 100%); max-height: 90vh; overflow: auto;
      border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    @media (max-width: 600px) {
      .dialog { height: 100%; max-height: none; border-radius: 0; }
    }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    h2 { font-size: 18px; margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    fieldset { border: none; padding: 0; margin: 0; }
    legend { font-size: 14px; font-weight: bold; }
    textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .chips button { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    .criteria { background: var(--surface-alt); padding: 12px; border-radius: 8px; }
    .pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 44px; }
    .check input { width: 22px; height: 22px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
  `,
})
export class StatusDialog implements OnInit {
  issue = input.required<Issue>();
  transition = input.required<Transition>();
  pid = input.required<string>();
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);

  readonly causeCategories = CAUSE_CATEGORIES;
  readonly effects: Effect[] = ['yes', 'partial', 'no'];

  reason = '';
  cause = '';
  countermeasure = '';
  learning = '';
  causeCategory = signal<CauseCategory | null>(null);
  effect = signal<Effect | null>(null);
  doneMet = signal(false);
  busy = signal(false);
  error = signal('');

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  ngOnInit() {
    // 対応中に書いた原因・対策があれば、最初から入れておく
    const i = this.issue();
    this.cause = i.cause ?? '';
    this.countermeasure = i.countermeasure ?? '';
    this.causeCategory.set(i.causeCategory ?? null);
  }

  canConfirm(): boolean {
    switch (this.transition().needs) {
      case 'reason': return !!this.reason.trim();
      case 'resolve': return !!(this.cause.trim() && this.countermeasure.trim() && this.causeCategory() && this.doneMet());
      case 'close': return !!(this.effect() && this.doneMet());
      default: return true;
    }
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.issueService.changeStatus(this.pid(), this.issue(), this.transition(), {
        reason: this.reason.trim(),
        cause: this.cause.trim(),
        countermeasure: this.countermeasure.trim(),
        causeCategory: this.causeCategory(),
        effect: this.effect(),
        learning: this.learning.trim(),
        doneCriteriaMet: this.doneMet(),
      }, auth.currentUser!.uid, this.tz());
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}