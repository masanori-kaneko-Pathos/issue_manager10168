import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { ReminderService, ReminderTarget } from '../../core/reminder/reminder.service';
import { DAILY_TIME_STEP, DEFAULT_DAILY_TIME, Reminder } from '../../core/models';
import { dateKey, formatDateTime, zonedTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { ChipMenu } from '../../shared/chip-menu';

const MIN = 60 * 1000;
const STEP = DAILY_TIME_STEP * MIN;

/** 瞬間の、timeZone での時と分 */
function hmIn(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d);
  return { h: Number(p.find((x) => x.type === 'hour')?.value ?? 0), m: Number(p.find((x) => x.type === 'minute')?.value ?? 0) };
}

/**
 * リマインドの変更の画面（窓の中身だけ。幕と窓の外側は reminder-host が持つ）。
 * target があれば課題・サブタスクのリマインド、なければ自由入力（current もなければ新しく作る）
 */
@Component({
  selector: 'app-reminder-dialog',
  imports: [FormsModule, RouterLink, TPipe, ChipMenu],
  template: `
    <!-- compact（新しく作る画面の中）のときは、上の段をその画面が持つので、ここでは時刻の欄から出す -->
    @if (!compact()) {
      @if (showBack()) {
        <div class="head">
          <button type="button" class="back" (click)="back.emit()">‹ {{ 'reminder.title' | t }}</button>
        </div>
      }
      @if (target(); as tg) {
        <!-- 課題の題名を押すと詳細へ（移ると窓は閉じる） -->
        <div class="target">
          <a [routerLink]="['/p', tg.pid, 'i', tg.iid]">{{ tg.sid ? tg.subTitle : '#' + tg.number + ' ' + tg.title }}</a>
          @if (tg.sid) { <span class="of">#{{ tg.number }} {{ tg.title }}</span> }
          @if (tg.projectName) { <span class="of">{{ tg.projectName }}</span> }
        </div>
        <label class="field">{{ 'reminder.note' | t }}
          <textarea [ngModel]="note()" (ngModelChange)="note.set($event)" rows="2" maxlength="1000"
            [placeholder]="'reminder.notePlaceholder' | t"></textarea>
        </label>
        <p class="help">{{ 'reminder.help' | t }}</p>
      } @else {
        <label class="field">{{ 'reminder.freeTitle' | t }}
          <input id="rm-title" [ngModel]="title()" (ngModelChange)="title.set($event)" maxlength="200"
            [placeholder]="'reminder.freePlaceholder' | t" />
        </label>
        <label class="field">{{ 'reminder.note' | t }}
          <textarea [ngModel]="note()" (ngModelChange)="note.set($event)" rows="2" maxlength="1000"
            [placeholder]="'reminder.notePlaceholder' | t"></textarea>
        </label>
        <p class="help">{{ 'reminder.freeHelp' | t }}</p>
      }
      @if (current(); as r) {
        <p class="now" [class.late]="!r.pending && !r.doneAt">{{ 'reminder.current' | t: { when: fmt(r.at.toDate()) } }}</p>
      }
    }

    <div class="presets">
      @for (p of presets(); track p.key) {
        <button type="button" [class.on]="touched() && picked()?.getTime() === p.at.getTime()" (click)="pick(p.at)">
          <span>{{ 'reminder.presets.' + p.key | t }}</span><span class="when">{{ fmt(p.at) }}</span>
        </button>
      }
    </div>

    <div class="custom">
      <input type="date" [ngModel]="day()" (ngModelChange)="day.set($event); touched.set(true)" [min]="todayKey()"
        [attr.aria-label]="'reminder.day' | t" />
      <!-- 通知設定の「届く時刻」と同じチップのプルダウン（見た目をアプリでそろえる） -->
      <app-chip-menu [label]="'reminder.hour' | t" [options]="hourMenu" [value]="hour()"
        (picked)="hour.set(+$event); touched.set(true)" />
      <app-chip-menu [label]="'reminder.minute' | t" [options]="minuteMenu" [value]="minute()"
        (picked)="minute.set(+$event); touched.set(true)" />
    </div>

    @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
    <div class="row">
      @if (current()) {
        <button type="button" class="link danger" [disabled]="busy()" (click)="removeIt()">{{ 'reminder.remove' | t }}</button>
      }
      <span class="spacer"></span>
      <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
      <button type="button" class="primary"
        [disabled]="busy() || !picked() || (needTarget() && !target()) || (!target() && !freeTitle().trim())"
        (click)="save()">{{ 'reminder.set' | t }}</button>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; }
    .head { display: flex; align-items: center; }
    .back { min-height: 36px; padding: 0 4px; margin-left: -4px; border: none; background: none; color: var(--primary);
      font: inherit; font-size: 14px; cursor: pointer; }
    .target { display: flex; flex-direction: column; gap: 2px; }
    .target a { font-weight: bold; color: var(--primary); overflow-wrap: anywhere; }
    .of { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .now { font-size: 13px; margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--primary-bg); }
    .now.late { background: var(--danger-bg); color: var(--danger-text); }
    .presets { display: flex; flex-direction: column; gap: 6px; }
    .presets button { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 44px;
      padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface);
      color: var(--text); font-size: 14px; cursor: pointer; text-align: left; }
    .presets button.on { border-color: var(--primary); background: var(--primary-bg); }
    .when { font-size: 12px; color: var(--text-muted); }
    .custom { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .custom input { padding: 0 8px; }
    .spacer { flex: 1; }
  `,
})
export class ReminderDialog implements OnInit {
  /** 課題・サブタスクのリマインドのとき、その課題（自由入力は null） */
  target = input<ReminderTarget | null>(null);
  /** 今のリマインド（新しく作るときは null） */
  current = input<Reminder | null>(null);
  done = output<void>();
  back = output<void>();
  cancel = output<void>();
  /** 「‹ リマインド」を出すか（新しく作る画面の中では、その画面が出すので出さない） */
  showBack = input(true);
  /** 課題から選ぶ画面の中で使うとき：課題を選ぶまでは、題名の欄の代わりに案内を出し、設定できないようにする */
  needTarget = input(false);
  /** 新しく作る画面の中で使うとき：時刻の欄とボタンだけを出す（上の段は、その画面が持つ） */
  compact = input(false);
  /** compact のときの自由入力の題名（上の段の欄に打ったもの） */
  extTitle = input('');
  /** compact のときの自由入力のメモ */
  extNote = input('');

  private reminders = inject(ReminderService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);

  /** チップのプルダウンの中身（通知設定の「届く時刻」と同じ：時は 0〜23、分は 00・10…50） */
  readonly hourMenu = Array.from({ length: 24 }, (_, i) => ({ value: i, label: String(i) }));
  readonly minuteMenu = Array.from({ length: 60 / DAILY_TIME_STEP }, (_, i) =>
    ({ value: i * DAILY_TIME_STEP, label: String(i * DAILY_TIME_STEP).padStart(2, '0') }));
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  todayKey = computed(() => dateKey(new Date(), this.tz()));

  /** 自由入力の題名 */
  title = signal('');
  /** 自由入力のメモ */
  note = signal('');
  /** 選んでいる日付・時・分（自分のタイムゾーン） */
  day = signal('');
  hour = signal(0);
  minute = signal(0);
  /** 時刻を自分で選び直したか（選び直していなければ、題名だけの直しとして扱う） */
  touched = signal(false);
  busy = signal(false);
  error = signal('');

  /** 自由入力の題名（compact なら上の段の欄、そうでなければ自分の欄） */
  freeTitle = computed(() => (this.compact() ? this.extTitle() : this.title()));

  freeNote = computed(() => (this.compact() ? this.extNote() : this.note()));

  /** 選んでいる日時（日付が空なら null） */
  picked = computed(() => {
    const m = this.day().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? zonedTime(+m[1], +m[2], +m[3], this.hour(), this.minute(), this.tz()) : null;
  });

  /** 早道：1時間後／今日の17:00（過ぎていたら出さない）／明日の朝（毎日のまとめと同じ時刻） */
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
    const cur = this.current();
    // 今の設定があればその時刻（届いたものでも、そのまま見せる）、なければ「1時間後」
    this.fill(cur?.at.toDate() ?? this.presets()[0].at);
    this.title.set(cur && !this.target() ? cur.title : '');
    this.note.set(cur?.note ?? '');
    if (!this.target() && !cur && !this.needTarget() && !this.compact()) {
      setTimeout(() => document.getElementById('rm-title')?.focus());
    }
  }

  /** 日時を、下の日付・時・分に入れる（分は10分刻みに切り下げる） */
  private fill(d: Date) {
    const { h, m } = hmIn(d, this.tz());
    this.day.set(dateKey(d, this.tz()));
    this.hour.set(h);
    this.minute.set(Math.floor(m / DAILY_TIME_STEP) * DAILY_TIME_STEP);
    this.error.set('');
  }

  /** 早道を押した（時刻を選び直した） */
  pick(d: Date) {
    this.fill(d);
    this.touched.set(true);
  }

  pad(m: number) {
    return String(m).padStart(2, '0');
  }

  fmt(d: Date) {
    return formatDateTime(d, this.tz(), this.i18n.lang());
  }

  async save() {
    const at = this.picked();
    const t = this.target();
    const cur = this.current();
    const title = this.freeTitle().trim();


    if (!at || (!t && !title)) return;
    // 時刻を変えたとき（新しく作るときも）だけ、過ぎた時刻を止める。題名だけの直しは、届いたものでもできる
    const timeChanged = this.touched() || !cur;
    if (timeChanged && at.getTime() <= Date.now()) {
      this.error.set('reminder.past');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const note = this.freeNote().trim();
      if (cur) {
        // 今あるものを直す（時刻を変えたら予定に戻る。変えていなければ、題名・メモだけ）。課題の題名は写しなので直さない
        await this.reminders.update(cur.id, t ? { note } : { title, note }, timeChanged ? at : null);
      } else if (t) {
        await this.reminders.addIssue(t, note, at);
      } else {
        await this.reminders.addFree(title, note, at);
      }
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async removeIt() {
    const cur = this.current();
    if (!cur) return;
    this.busy.set(true);
    try {
      await this.reminders.removeById(cur.id);
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}