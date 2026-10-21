import { Component, ElementRef, afterEveryRender, inject, signal } from '@angular/core';

/**
 * タブの下の青い線（1本だけ）。置いた入れ物の中の「.on が付いたタブ」の位置と幅を測り、そこへすべって移る。
 * 入れ物（タブの並び）には position: relative を付けること
 */
@Component({
  selector: 'app-tab-ink',
  host: {
    '(window:resize)': 'place()',
    '[class.ready]': 'ready()',
    '[style.width.px]': 'w()',
    '[style.translate]': "x() + 'px 0'",
  },
  template: '',
  styles: `
    :host { position: absolute; left: 0; bottom: 0; height: 2px; border-radius: 2px; background: var(--primary);
      pointer-events: none; }
    /* 最初の1回は動かさずに置き、そのあとから、すべらせる（開いた瞬間に左端からすべってこないように） */
    :host(.ready) { transition: translate 220ms var(--ease-out), width 220ms var(--ease-out); }
  `,
})
export class TabInk {
  private el = inject<ElementRef<HTMLElement>>(ElementRef);
  x = signal(0);
  w = signal(0);
  ready = signal(false);

  constructor() {
    afterEveryRender(() => this.place());
  }

  /** 今いるタブを測る。今いるタブがない画面（削除フォルダなど）では、線を隠す */
  place() {
    const a = this.el.nativeElement.parentElement?.querySelector<HTMLElement>('.on');
    const x = a ? a.offsetLeft : this.x();
    const w = a ? a.offsetWidth : 0;
    if (x !== this.x()) this.x.set(x);
    if (w !== this.w()) this.w.set(w);
    if (a && !this.ready()) requestAnimationFrame(() => this.ready.set(true));
  }
}