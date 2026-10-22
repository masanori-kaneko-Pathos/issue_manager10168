import { Component, computed, input, output, signal } from '@angular/core';

/** プルダウンの1行（label は呼ぶ側で翻訳した文字） */
export interface ChipOption { value: string | number; label: string; }

/**
 * チップの形のプルダウン（「分け方：ステータス ▾」）。押すと、ほかの ▾ と同じ形のメニューが下に開く。
 * 押すボタンはチップの基準（styles.css の .chips button）のまま。active なら青く塗る（絞り込み中の印）
 */
@Component({
  selector: 'app-chip-menu',
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <div class="chips">
      <button type="button" aria-haspopup="menu" [attr.aria-expanded]="open()" [class.on]="active()"
        (click)="open.set(!open())">{{ label() }}：{{ current() }} <span aria-hidden="true">▾</span></button>
    </div>
    @if (open()) {
      <div class="backdrop" (click)="open.set(false)"></div>
      <div class="menu" role="menu" animate.leave="im-out">
        @for (o of options(); track o.value) {
          <button type="button" role="menuitemradio" [attr.aria-checked]="o.value === value()"
            [class.on]="o.value === value()" (click)="choose(o.value)">
            <span class="tick" aria-hidden="true">{{ o.value === value() ? '✓' : '' }}</span>{{ o.label }}</button>
        }
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-block; }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; left: 0; top: calc(100% + 4px); z-index: 52; min-width: 160px;
      display: flex; flex-direction: column; padding: 6px 0; border-radius: 10px;
      background: var(--surface); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .menu button { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; border: none;
      background: none; color: var(--text); font-size: 14px; text-align: left; white-space: nowrap; cursor: pointer; }
    .menu button:hover { background: var(--surface-alt); }
    .menu button.on { font-weight: bold; color: var(--primary); }
    .tick { width: 14px; }
  `,
})
export class ChipMenu {
  label = input.required<string>();
  options = input.required<ChipOption[]>();
  value = input.required<string | number>();
  /** 初期値でないものを選んでいる（絞り込み中）なら true。チップを青く塗る */
  active = input(false);
  picked = output<string | number>();

  open = signal(false);
  current = computed(() => this.options().find((o) => o.value === this.value())?.label ?? '');

  choose(v: string | number) {
    this.open.set(false);
    this.picked.emit(v);
  }
}