import { Component, ElementRef, inject, input, signal } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/** マウスを乗せられる端末か（乗せる操作がない端末＝スマホ・タブレットは、押して開く） */
const HOVER = typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * 「？」の説明。PC は乗せると出て、離れると消える（吹き出しの上に移っても消えない）。キーボードで移ったときも出る。
 * スマホは押して開き、下からの板で出す。help＝説明、denied＝押せない理由（オレンジ）。「!」は期限切れ専用
 */
@Component({
  selector: 'app-help-tip',
  imports: [TPipe],
  host: {
    '(document:keydown.escape)': 'open.set(false)',
    '(document:click)': 'onDocClick($event)',
    '(mouseenter)': 'hoverIn()',
    '(mouseleave)': 'hoverOut()',
    '(focusin)': 'focusIn()',
    '(focusout)': 'hoverOut()',
  },
  template: `
    <button type="button" class="tip-btn" [class.denied]="kind() === 'denied'"
      [attr.aria-label]="(kind() === 'denied' ? 'tip.whyDisabled' : 'tip.help') | t"
      [attr.aria-expanded]="open()" (click)="onClick()">
      <!-- 文字の「?」は書体によって下に寄るので、線の絵で描いて真ん中にそろえる -->
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 2.6-2.9 4" /><path d="M12 18.5h.01" /></svg>
    </button>
    @if (open()) {
      <div class="backdrop" (click)="open.set(false)"></div>
      <div class="pop" [class.right]="align() === 'right'" role="dialog" animate.leave="im-out">
        @for (k of keys(); track k) { <p>{{ k | t }}</p> }
        <button type="button" class="close" (click)="open.set(false)">{{ 'list.close' | t }}</button>
      </div>
    }
  `,
  styles: `
        /* 円の真ん中を、横の文字（日本語）の高さの真ん中にそろえる（middle は英小文字の真ん中なので、少し下にずれる） */
    :host { position: relative; display: inline-flex; vertical-align: -0.05em; }
    /* 見た目は 16px（横の見出しの文字より一回り小さく）。中の「?」は線の絵なので、いつも真ん中 */
    .tip-btn { position: relative; display: inline-flex; align-items: center; justify-content: center;
      box-sizing: border-box; width: 12px; height: 12px; padding: 0; border: none; border-radius: 50%;
      background: var(--border-strong); color: var(--on-primary); cursor: help; }
    .tip-btn:hover, .tip-btn[aria-expanded='true'] { background: var(--text-disabled); }
    /* 見た目は小さく、乗せる・押せる範囲は広く（透明な余白） */
    .tip-btn::before { content: ''; position: absolute; inset: -10px; }
    @media (pointer: coarse) { .tip-btn::before { inset: -14px; } }
    /* オレンジは、今の色に白（面の色）を3割まぜて薄く。乗せたら元の濃さ */
    .tip-btn.denied { background: color-mix(in srgb, var(--warning) 45%, var(--surface)); }
    .tip-btn.denied:hover, .tip-btn.denied[aria-expanded='true'] { background: color-mix(in srgb, var(--warning) 75%, var(--surface)); }
    .backdrop { display: none; position: fixed; inset: 0; z-index: 60; }
    .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 61; width: max-content;
      max-width: min(300px, 80vw); background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
      padding: 10px 12px; font-size: 13px; font-weight: normal; line-height: 1.6; text-align: left; }
    .pop.right { left: auto; right: 0; }
    .pop p { margin: 0 0 6px; }
    .pop p:last-of-type { margin-bottom: 0; }
    .close { display: none; }
    @media (max-width: 600px) {
      .backdrop { display: block; background: rgba(0, 0, 0, 0.3); }
      .pop, .pop.right { position: fixed; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-width: none;
        border-radius: 16px 16px 0 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom)); font-size: 15px; }
      .close { display: block; width: 100%; min-height: 44px; margin-top: 12px; border: none; border-radius: 8px;
        background: var(--primary); color: var(--on-primary); font-size: 15px; }
    }
  `,
})
export class HelpTip {
  /** 表示する説明の翻訳キー（複数なら段落に分けて出す） */
  keys = input.required<string[]>();
  /** help=説明、denied=押せない理由（どちらも「？」。denied はオレンジの枠で区別。「!」は期限切れ専用） */
  kind = input<'help' | 'denied'>('help');
  /** 吹き出しを右に寄せる（画面の右端に置くとき） */
  align = input<'left' | 'right'>('left');

  open = signal(false);

  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** 離れてから消すまでの時計（「?」から吹き出しへ、すき間をまたいで移るときに消えないように） */
  private timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 乗せた（PC だけ）：0.3秒そのままでいたら出す（通り過ぎただけでは出さない）。
   * もう出ているとき（吹き出しから「?」へ戻ってきたときなど）は、消す時計を止めるだけ
   */
  hoverIn() {
    if (!HOVER) return;
    clearTimeout(this.timer);
    if (this.open()) return;
    this.timer = setTimeout(() => this.open.set(true), 300);
  }

  /** キーボードで移った（PC だけ）：待たずに出す */
  focusIn() {
    if (!HOVER) return;
    clearTimeout(this.timer);
    this.open.set(true);
  }

  /** 離れた（PC だけ）：少し待ってから消す。待っている間に吹き出しの上へ入れば、hoverIn が時計を止める */
  hoverOut() {
    if (!HOVER) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open.set(false), 120);
  }

  /** 押した：PC は出したまま（乗せた時点でもう出ている）、スマホは開く・閉じる */
  onClick() {
    if (HOVER) this.open.set(true);
    else this.open.set(!this.open());
  }

  /** 吹き出しの外を押したら閉じる。幕を使わないので、押したもの（戻るボタンなど）にもクリックが届く */
  onDocClick(e: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }
}