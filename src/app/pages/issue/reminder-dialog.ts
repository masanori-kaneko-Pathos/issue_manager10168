import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { ReminderService } from '../../core/reminder/reminder.service';
import { DAILY_TIME_STEP, DEFAULT_DAILY_TIME, Issue, Reminder, Subtask } from '../../core/models';
import { dateKey, formatDateTime, zonedTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';

const MIN = 60 * 1000;
const STEP = DAILY_TIME_STEP * MIN;

/** 瞬間の、timeZone での時と分 */
function hmIn(d: Date, tz: string) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(d);
    return { h: Number(p.find((x) => x.type === 'hour')?.value ?? 0), m: Number(p.find((x) => x.type === 'minute')?.value ?? 0) };
}

/** 課題のリマインドを置く・変える・外す窓 */
@Component({
    selector: 'app-reminder-dialog',
    imports: [FormsModule, TPipe],
    host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
    template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'reminder.title' | t">
      <h2>{{ 'reminder.title' | t }}</h2>
      <p class="target">{{ sub()?.title ?? ('#' + issue().number + ' ' + issue().title) }}</p>
      <p class="help">{{ 'reminder.help' | t }}</p>
      @if (current(); as r) { <p class="now">{{ 'reminder.current' | t: { when: fmt(r.at.toDate()) } }}</p> }

      <div class="presets">
        @for (p of presets(); track p.key) {
          <button type="button" [class.on]="picked()?.getTime() === p.at.getTime()" (click)="pick(p.at)">
            <span>{{ 'reminder.presets.' + p.key | t }}</span><span class="when">{{ fmt(p.at) }}</span>
          </button>
        }
      </div>

      <div class="custom">
        <input type="date" [ngModel]="day()" (ngModelChange)="day.set($event)" [min]="todayKey()"
          [attr.aria-label]="'reminder.day' | t" />
        <select [attr.aria-label]="'reminder.hour' | t" (change)="hour.set(+$any($event.target).value)">
          @for (h of hourList; track h) { <option [value]="h" [selected]="hour() === h">{{ h }}</option> }
        </select>
        <span aria-hidden="true">:</span>
        <select [attr.aria-label]="'reminder.minute' | t" (change)="minute.set(+$any($event.target).value)">
          @for (m of minuteList; track m) { <option [value]="m" [selected]="minute() === m">{{ pad(m) }}</option> }
        </select>
      </div>

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        @if (current()) {
          <button type="button" class="link danger" [disabled]="busy()" (click)="removeIt()">{{ 'reminder.remove' | t }}</button>
        }
        <span class="spacer"></span>
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !picked()" (click)="save()">{{ 'reminder.set' | t }}</button>
      </div>
    </section>
  `,
    styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .target { margin: 0; font-weight: bold; overflow-wrap: anywhere; }
    .now { font-size: 13px; margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--primary-bg); }
    .presets { display: flex; flex-direction: column; gap: 6px; }
    .presets button { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 44px;
      padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface);
      color: var(--text); font-size: 14px; cursor: pointer; text-align: left; }
    .presets button.on { border-color: var(--primary); background: var(--primary-bg); }
    .when { font-size: 12px; color: var(--text-muted); }
    .custom { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .custom input, .custom select { padding: 0 8px; }
    .spacer { flex: 1; }
  `,
})
export class ReminderDialog implements OnInit {
    pid = input.required<string>();
    issue = input.required<Issue>();
    projectName = input('');
    current = input<Reminder | null>(null);
    /** サブタスクのリマインドのとき、そのサブタスク */
    sub = input<Subtask | null>(null);
    /** 設定した時刻（外したときは null） */
    done = output<Date | null>();
    cancel = output<void>();

    private reminders = inject(ReminderService);
    private authService = inject(AuthService);
    private i18n = inject(I18nService);

    readonly hourList = Array.from({ length: 24 }, (_, i) => i);
    readonly minuteList = Array.from({ length: 60 / DAILY_TIME_STEP }, (_, i) => i * DAILY_TIME_STEP);
    private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
    todayKey = computed(() => dateKey(new Date(), this.tz()));

    /** 選んでいる日付・時・分（自分のタイムゾーン） */
    day = signal('');
    hour = signal(0);
    minute = signal(0);
    busy = signal(false);
    error = signal('');

    /** 選んでいる日時（日付が空なら null） */
    picked = computed(() => {
        const m = this.day().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? zonedTime(+m[1], +m[2], +m[3], this.hour(), this.minute(), this.tz()) : null;
    });

    /** 早道：1時間後／今日の17:00（過ぎていたら出さない）／明日の朝（毎朝のまとめと同じ時刻） */
    presets = computed(() => {
        const now = Date.now();
        const tz = this.tz();
        const at = (key: string, h: number, m: number) => {
            const [y, mo, d] = key.split('-').map(Number);
            return zonedTime(y, mo, d, h, m, tz);
        };
        const today = dateKey(new Date(now), tz);
        const tomorrow = dateKey(new Date(now + 24 * 60 * MIN), tz);
        // 毎日のまとめの時刻。届けない（'off'）にしている人は、初期の 10:00 を「明日の朝」にする
        const dt = this.authService.profile()?.dailyTime;
        const morning = typeof dt === 'number' ? dt : DEFAULT_DAILY_TIME;
        const list = [{ key: 'in1h', at: new Date(Math.ceil((now + 60 * MIN) / STEP) * STEP) }];
        const five = at(today, 17, 0);
        if (five.getTime() > now) list.push({ key: 'today', at: five });
        list.push({ key: 'tomorrow', at: at(tomorrow, Math.floor(morning / 60), morning % 60) });
        return list;
    });

    ngOnInit() {
        // 今の設定があればそれ、なければ「1時間後」を入れておく
        this.pick(this.current()?.at.toDate() ?? this.presets()[0].at);
    }

    /** 日時を、下の日付・時・分に入れる（分は10分刻みに切り下げる） */
    pick(d: Date) {
        const { h, m } = hmIn(d, this.tz());
        this.day.set(dateKey(d, this.tz()));
        this.hour.set(h);
        this.minute.set(Math.floor(m / DAILY_TIME_STEP) * DAILY_TIME_STEP);
        this.error.set('');
    }

    pad(m: number) {
        return String(m).padStart(2, '0');
    }

    fmt(d: Date) {
        return formatDateTime(d, this.tz(), this.i18n.lang());
    }

    async save() {
        const at = this.picked();
        if (!at) return;
        if (at.getTime() <= Date.now()) {
            this.error.set('reminder.past');
            return;
        }
        this.busy.set(true);
        this.error.set('');
        try {
            await this.reminders.set(this.pid(), this.issue(), this.projectName(), at, this.sub());
            this.done.emit(at);
        } catch (e) {
            console.error(e);
            this.error.set('common.saveError');
        } finally {
            this.busy.set(false);
        }
    }

    async removeIt() {
        this.busy.set(true);
        try {
            await this.reminders.remove(this.pid(), this.issue().id, this.sub()?.id ?? null);
            this.done.emit(null);
        } catch (e) {
            console.error(e);
            this.error.set('common.saveError');
        } finally {
            this.busy.set(false);
        }
    }
}