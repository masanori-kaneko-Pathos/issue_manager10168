import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';

/** プルダウンの1行（label は呼ぶ側で翻訳した文字） */
export interface ChipOption { value: string | number; label: string; }

/**
 * チップの形のプルダウン（「分け方：ステータス ▾」）。押すと、ほかの ▾ と同じ形のメニューが下に開く。
 * 押すボタンはチップの基準（styles.css の .chips button）のまま。active なら青く塗る（絞り込み中の印）
 */
@Component({
  selector: 'app-chip-menu',
  host: {
    // フォーカスがほかの所にあるときの Esc（document まで上がってきたもの）でも閉じる
    '(document:keydown.escape)': 'open.set(false)',
    // 一覧の中の Esc は、document に上がる前にここで受ける（開いているときは止めて、窓まで閉じないように）
    '(keydown.escape)': 'onEsc($event)',
  },
  template: `
    <div class="chips">
      <button type="button" aria-haspopup="menu" [attr.aria-expanded]="open()" [class.on]="active()"
        (click)="toggle()">{{ label() }}：{{ current() }} <span aria-hidden="true">▾</span></button>
    </div>
    @if (open()) {
      <div class="backdrop" (click)="open.set(false)"></div>
      <div class="menu" role="menu" [class.up]="up()" [style.max-height.px]="maxH()" animate.leave="im-out">
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
    /* 長い一覧（届く時刻の「時」は24個）は、中でスクロールする */
    .menu { position: absolute; left: 0; top: calc(100% + 4px); z-index: 52; min-width: 160px;
      max-height: 320px; overflow-y: auto;
      display: flex; flex-direction: column; padding: 6px 0; border-radius: 10px;
      background: var(--surface); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .menu button { flex: none; display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; border: none;
      background: none; color: var(--text); font-size: 14px; text-align: left; white-space: nowrap; cursor: pointer; }
    .menu button:hover { background: var(--surface-alt); }
    .menu button.on { font-weight: bold; color: var(--primary); }
    .tick { width: 14px; }
    /* 下に空きがないときは、チップの上へ開く */
    .menu.up { top: auto; bottom: calc(100% + 4px); }
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
  /** 上へ開くか（下に空きがないとき） */
  up = signal(false);
  /** 一覧の高さ（開く向きの空きに合わせる） */
  maxH = signal(320);
  private el = inject(ElementRef<HTMLElement>);

  /**
   * 開け閉め。開くときは、下と上のどちらに空きがあるかを測って向きと高さを決める
   * （窓の中なら窓の縁まで、ページなら画面の縁まで。窓の中で下に開くと、窓ごと伸びてスクロールになるため）。
   * 開いたら、選んでいる行が見えるところまで一覧をスクロールする
   */
  toggle() {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    const host = this.el.nativeElement as HTMLElement;
    const r = host.getBoundingClientRect();
    const box = host.closest('.dialog')?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    const below = box.bottom - r.bottom - 12;
    const above = r.top - box.top - 12;
    const up = below < 200 && above > below;
    this.up.set(up);
    this.maxH.set(Math.max(120, Math.min(320, up ? above : below)));
    this.open.set(true);
    // 選んでいる行（なければ先頭）が見えるところまでスクロールし、フォーカスを移す
    // （Mac の Safari はボタンを押してもフォーカスが移らず、Esc が一覧を通らずに document へ行くため）
    setTimeout(() => {
      const row = host.querySelector<HTMLElement>('.menu .on') ?? host.querySelector<HTMLElement>('.menu button');
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    });
  }

  /** 開いているときの Esc：一覧だけ閉じて、ここで止める（窓まで閉じない）。フォーカスはチップに戻す */
  onEsc(e: Event) {
    if (!this.open()) return; // 閉じているときは止めない（窓の Esc として、そのまま上へ）
    e.stopPropagation();
    this.open.set(false);
    (this.el.nativeElement as HTMLElement).querySelector<HTMLElement>('.chips button')?.focus();
  }  
  current = computed(() => this.options().find((o) => o.value === this.value())?.label ?? '');

  choose(v: string | number) {
    this.open.set(false);
    this.picked.emit(v);
  }
}