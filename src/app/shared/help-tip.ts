import { Component, input, signal } from '@angular/core';
import { TPipe } from '../i18n/i18n';

@Component({
  selector: 'app-help-tip',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <button type="button" class="tip-btn" [class.denied]="kind() === 'denied'"
      [attr.aria-label]="(kind() === 'denied' ? 'tip.whyDisabled' : 'tip.help') | t"
      [attr.aria-expanded]="open()" (click)="open.set(!open())">
      {{ kind() === 'denied' ? '!' : '?' }}
    </button>
    @if (open()) {
      <div class="backdrop" (click)="open.set(false)"></div>
      <div class="pop" [class.right]="align() === 'right'" role="dialog">
        @for (k of keys(); track k) { <p>{{ k | t }}</p> }
        <button type="button" class="close" (click)="open.set(false)">{{ 'list.close' | t }}</button>
      </div>
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; vertical-align: middle; }
    .tip-btn { position: relative; width: 22px; height: 22px; padding: 0; border-radius: 50%;
      border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-muted);
      font-size: 12px; font-weight: bold; line-height: 1; cursor: pointer; }
    /* 見た目は小さく、押せる範囲は広く（44px） */
    .tip-btn::before { content: ''; position: absolute; inset: -11px; }
    .tip-btn.denied { border-color: var(--warning); background: var(--warning-bg); color: var(--warning-text); }
    .backdrop { position: fixed; inset: 0; z-index: 60; }
    .pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 61; width: max-content;
      max-width: min(300px, 80vw); background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
      padding: 10px 12px; font-size: 13px; font-weight: normal; line-height: 1.6; text-align: left; }
    .pop.right { left: auto; right: 0; }
    .pop p { margin: 0 0 6px; }
    .pop p:last-of-type { margin-bottom: 0; }
    .close { display: none; }
    @media (max-width: 600px) {
      .backdrop { background: rgba(0, 0, 0, 0.3); }
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
  /** help=「？」（説明）、denied=「！」（押せない理由） */
  kind = input<'help' | 'denied'>('help');
  /** 吹き出しを右に寄せる（画面の右端に置くとき） */
  align = input<'left' | 'right'>('left');

  open = signal(false);
}