import { AfterContentInit, Component, ElementRef, inject, signal } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/**
 * パスワードの欄に「目」のボタンを付ける。中に入れた input の種類を、password ⇔ text で切り替える。
 * 使い方：<app-pw-field><input type="password" ... /></app-pw-field>
 * （ブラウザが自分で付ける目は Edge にしかないので、どのブラウザでも同じに見えるよう、自前で付ける）
 */
@Component({
  selector: 'app-pw-field',
  imports: [TPipe],
  template: `
    <ng-content />
    <button type="button" class="eye" [attr.aria-label]="(shown() ? 'pw.hide' : 'pw.show') | t"
      [title]="(shown() ? 'pw.hide' : 'pw.show') | t" [attr.aria-pressed]="shown()" (click)="toggle()">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
        @if (shown()) { <path d="M3 3l18 18" /> }
      </svg>
    </button>
  `,
  styles: `
    :host { position: relative; display: block; }
    .eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center; padding: 0; border: none; border-radius: 6px;
      background: none; color: var(--text-muted); cursor: pointer; }
    .eye:hover { background: var(--surface-alt); color: var(--text); }
  `,
})
export class PwField implements AfterContentInit {
  private host = inject(ElementRef<HTMLElement>);
  private input: HTMLInputElement | null = null;
  shown = signal(false);

  ngAfterContentInit() {
    this.input = this.host.nativeElement.querySelector('input');
    if (this.input) {
      // 目のボタンに文字が重ならないように、右に余白を取り、横いっぱいに広げる
      this.input.style.paddingRight = '44px';
      this.input.style.width = '100%';
      this.input.style.boxSizing = 'border-box';
    }
  }

  toggle() {
    if (!this.input) return;
    this.shown.set(!this.shown());
    this.input.type = this.shown() ? 'text' : 'password';
  }
}