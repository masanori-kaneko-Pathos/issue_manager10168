import { Component, computed, input } from '@angular/core';
import { Label, labelColor } from '../core/models';

@Component({
  selector: 'app-label-chip',
  host: { '[attr.data-color]': 'color()' },
  template: `{{ label().name }}`,
  styles: `
    :host { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; line-height: 18px; white-space: nowrap;
      background: var(--label-gray-bg); color: var(--label-gray); }
    :host([data-color='blue'])   { background: var(--label-blue-bg);   color: var(--label-blue); }
    :host([data-color='green'])  { background: var(--label-green-bg);  color: var(--label-green); }
    :host([data-color='orange']) { background: var(--label-orange-bg); color: var(--label-orange); }
    :host([data-color='red'])    { background: var(--label-red-bg);    color: var(--label-red); }
    :host([data-color='purple']) { background: var(--label-purple-bg); color: var(--label-purple); }
  `,
})
export class LabelChip {
  label = input.required<Label>();
  color = computed(() => labelColor(this.label()));
}