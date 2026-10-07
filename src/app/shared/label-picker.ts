import { Component, computed, input, model } from '@angular/core';
import { Label, MAX_LABELS_PER_ISSUE } from '../core/models';
import { TPipe } from '../i18n/i18n';
import { LabelChip } from './label-chip';

@Component({
  selector: 'app-label-picker',
  imports: [LabelChip, TPipe],
  template: `
    @if (labels().length === 0) {
      <p class="help">{{ 'labelPicker.none' | t }}</p>
    } @else {
      <div class="chips">
        @for (l of labels(); track l.id) {
          @let on = selected().includes(l.id);
          <button type="button" class="pick" [class.on]="on" [disabled]="!on && full()"
            [attr.aria-pressed]="on" (click)="toggle(l.id)">
            <app-label-chip [label]="l" />
            @if (on) { <span class="check" aria-hidden="true">✓</span> }
          </button>
        }
      </div>
      <p class="help">{{ 'labelPicker.count' | t: { n: '' + selected().length, max: '' + max } }}</p>
    }
  `,
  styles: `
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .pick { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; padding: 4px 8px;
      border: 2px solid var(--border); background: var(--surface); border-radius: 20px; cursor: pointer; }
    .pick.on { border-color: var(--primary); }
    .pick:disabled { opacity: 0.4; cursor: default; }
    .check { color: var(--primary); font-weight: bold; font-size: 13px; }
    .help { font-size: 12px; color: var(--text-muted); font-weight: normal; margin: 4px 0 0; }
  `,
})
export class LabelPicker {
  labels = input.required<Label[]>();
  /** 選んでいるラベルの id。親と双方向でつながる */
  selected = model<string[]>([]);

  readonly max = MAX_LABELS_PER_ISSUE;
  full = computed(() => this.selected().length >= this.max);

  toggle(id: string) {
    const cur = this.selected();
    this.selected.set(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }
}