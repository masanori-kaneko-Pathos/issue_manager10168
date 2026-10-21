import { Component, computed, input } from '@angular/core';
import { Label, labelColor } from '../core/models';

@Component({
  selector: 'app-label-chip',
  // 切れたときも全文がわかるように、乗せると名前が出る
  host: { '[attr.data-color]': 'color()', '[attr.title]': 'label().name' },
  template: `<span class="t">{{ label().name }}</span>`,
  styles: `
    /* 幅は置かれた場所まで。入りきらない名前は「…」で切る（ラベルは20文字までなので、切れるのは狭い所だけ） */
    :host { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; box-sizing: border-box;
      padding: 1px 8px; border-radius: 10px; font-size: 11px; line-height: 18px;
      background: var(--label-gray-bg); color: var(--label-gray); }
    .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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