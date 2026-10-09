import { Component, booleanAttribute, computed, input } from '@angular/core';
import { Level } from '../core/models';
import { PRIORITY_BARS } from '../core/priority';
import { TPipe } from '../i18n/i18n';

/** 3本の棒の位置と高さ（固定）。変わるのは塗るかどうかだけ */
const BARS = [
  { x: 0, h: 4 },
  { x: 5, h: 8 },
  { x: 10, h: 12 },
];

@Component({
  selector: 'app-priority-mark',
  imports: [TPipe],
  host: { '[attr.data-p]': 'level()' },
  template: `
    @let text = (manual() ? 'priorityMark.manual' : 'priorityMark.label') | t: { p: ('priority.' + level() | t) };
    <span class="mark" role="img" [attr.aria-label]="text" [title]="text">
      <svg viewBox="0 0 13 12" width="13" height="12" aria-hidden="true">
        @for (b of bars; track $index) {
          <rect [attr.x]="b.x" [attr.y]="12 - b.h" width="3" [attr.height]="b.h" rx="1"
            [class.on]="$index < count()" />
        }
      </svg>
      @if (showText()) {
        <span class="text" aria-hidden="true">{{ 'priority.' + level() | t }}</span>
      }
    </span>
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
    .mark { display: inline-flex; align-items: center; gap: 4px; }
    rect { fill: var(--disabled); }
    :host([data-p='high']) rect.on { fill: var(--danger); }
    :host([data-p='mid'])  rect.on { fill: var(--warning); }
    :host([data-p='low'])  rect.on { fill: var(--success); }
    .text { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
  `,
})
export class PriorityMark {
  level = input.required<Level>();
  manual = input(false);
  showText = input(false, { transform: booleanAttribute });

  readonly bars = BARS;
  count = computed(() => PRIORITY_BARS[this.level()]);
}