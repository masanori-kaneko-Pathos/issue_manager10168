import { Component, computed, inject, input, output, signal } from '@angular/core';
import { I18nService, TPipe } from '../i18n/i18n';

/**
 * カレンダーの見出し「2026年11月 ▾」と、押すと開く年月の選び窓。
 * 選んだら、その月の1日（'YYYY-MM-DD'）を知らせるだけ（どう移るかは、呼ぶ側が決める）
 */
@Component({
  selector: 'app-month-picker',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <h2 class="title-h">
      <button type="button" class="title" aria-haspopup="dialog" [attr.aria-expanded]="open()"
        [attr.aria-label]="('calendar.pick' | t) + '：' + label()" (click)="toggle()">
        {{ label() }} <span class="caret" aria-hidden="true">▾</span></button>
    </h2>
    @if (open()) {
      <div class="backdrop" (click)="open.set(false)"></div>
      <div class="picker" role="dialog" [attr.aria-label]="'calendar.pick' | t">
        <div class="picker-head">
          <button type="button" class="arrow" [attr.aria-label]="'calendar.prevYear' | t"
            (click)="year.set(year() - 1)">‹</button>
          <strong>{{ yearLabel() }}</strong>
          <button type="button" class="arrow" [attr.aria-label]="'calendar.nextYear' | t"
            (click)="year.set(year() + 1)">›</button>
        </div>
        <div class="months">
          @for (m of monthNames(); track $index; let k = $index) {
            <button type="button" [class.on]="isShown(k)" [class.now]="isThisMonth(k)"
              [attr.aria-current]="isShown(k) ? 'date' : null" (click)="pick(k)">{{ m }}</button>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host { position: relative; }
    .title-h { margin: 0; font-size: 16px; }
    .title { min-height: 36px; padding: 0 10px; border: none; border-radius: 8px; background: none; color: var(--text);
      font: inherit; font-weight: bold; white-space: nowrap; cursor: pointer; }
    .title:hover { background: var(--surface-alt); }
    .caret { font-size: 11px; color: var(--text-muted); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .picker { position: absolute; top: calc(100% + 4px); left: 50%; transform: translateX(-50%); z-index: 52;
      width: 264px; padding: 10px; background: var(--surface); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .picker-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .arrow { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--text);
      font-size: 20px; line-height: 1; cursor: pointer; }
    .arrow:hover { background: var(--surface-alt); }
    .months { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    .months button { min-height: 40px; border: none; border-radius: 8px; background: none; color: var(--text);
      font-size: 13px; cursor: pointer; }
    .months button:hover { background: var(--surface-alt); }
    .months button.now { color: var(--primary); font-weight: bold; }
    .months button.on { background: var(--primary); color: var(--on-primary); }
  `,
})
export class MonthPicker {
  /** 今見ている日（'YYYY-MM-DD'） */
  value = input.required<string>();
  /** 見出しに出す文字（「2026年11月」や、週なら「10月18日 – 10月24日」） */
  label = input.required<string>();
  /** 今日（'YYYY-MM-DD'。選び窓で、今日の月を太字に） */
  today = input.required<string>();
  /** 選んだ月の1日 */
  picked = output<string>();

  private i18n = inject(I18nService);
  open = signal(false);
  /** 選び窓で見ている年（開くたびに、今見ている年に戻す） */
  year = signal(2026);
  private locale = computed(() => (this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US'));

  /** 1月〜12月の名前（日本語なら「1月」、英語なら「Jan」） */
  monthNames = computed(() => {
    const fmt = new Intl.DateTimeFormat(this.locale(), { month: 'short', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, k) => fmt.format(new Date(Date.UTC(2026, k, 1))));
  });
  yearLabel = computed(() => new Intl.DateTimeFormat(this.locale(), { year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(this.year(), 0, 1))));

  toggle() {
    if (!this.open()) this.year.set(Number(this.value().slice(0, 4)));
    this.open.set(!this.open());
  }

  /** 'YYYY-MM-DD' が、選び窓で見ている年の k 月か */
  private same(key: string, k: number) {
    return Number(key.slice(0, 4)) === this.year() && Number(key.slice(5, 7)) - 1 === k;
  }
  isShown(k: number) {
    return this.same(this.value(), k);
  }
  isThisMonth(k: number) {
    return this.same(this.today(), k);
  }

  pick(k: number) {
    this.open.set(false);
    this.picked.emit(`${this.year()}-${String(k + 1).padStart(2, '0')}-01`);
  }
}