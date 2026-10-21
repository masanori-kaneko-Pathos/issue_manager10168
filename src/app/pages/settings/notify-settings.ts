import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { PushService } from '../../core/notification/push.service';
import { DAILY_GROUPS, DAILY_TIME_STEP, DEFAULT_DAILY_TIME, DailyGroup, EMAIL_GROUPS, EmailGroup } from '../../core/models';
import { auth } from '../../core/firebase';
import { DEFAULT_DUE_REMINDERS, REMINDER_BUCKETS, ReminderBucket } from '../../core/time/time';
import { TPipe } from '../../i18n/i18n';
import { HelpTip } from '../../shared/help-tip';

type Changes = Parameters<AuthService['updateProfile']>[0];

/**
 * 通知設定：毎朝のまとめの時刻（1日1回・全プロジェクト分）、まとめの形、期限前の通知、プッシュ。
 * 変えたらすぐ保存する（プッシュの欄と同じ手触りにそろえる）
 */
@Component({
  selector: 'app-notify-settings',
  imports: [RouterLink, TPipe, HelpTip],
  template: `
    <header class="bar"><a routerLink="/settings" class="link">{{ 'notifySettings.back' | t }}</a></header>
    <main>
      <h1>{{ 'notifySettings.title' | t }}</h1>
      @if (msg(); as m) { <p class="msg" [class.ng]="!m.ok" role="status">{{ m.key | t }}</p> }
      
      <section>
        <h2>{{ 'push.title' | t }} <app-help-tip [keys]="['push.help']" /></h2>
        @switch (push.state()) {
          @case ('on') {
            <p class="help">{{ 'push.on' | t }}</p>
            <button type="button" class="link" [disabled]="pushBusy()" (click)="togglePush(false)">
              {{ 'push.disable' | t }}</button>
          }
          @case ('off') {
            <p class="help">{{ 'push.off' | t }}</p>
            <button type="button" class="primary" [disabled]="pushBusy()" (click)="togglePush(true)">
              {{ 'push.enable' | t }}</button>
          }
          @case ('blocked') { <p class="help">{{ 'push.blocked' | t }}</p> }
          @default { <p class="help">{{ 'push.unsupported' | t }}</p> }
        }
        @if (pushError()) { <p class="msg ng">{{ pushError() | t }}</p> }
      </section>

      <section>
        <h2>{{ 'emailNotify.title' | t }} <app-help-tip [keys]="['emailNotify.help']" /></h2>
        <p class="help">{{ 'emailNotify.to' | t: { email: email } }}</p>
        @if (!verified) { <p class="msg ng">{{ 'emailNotify.unverified' | t }}</p> }
        @for (g of emailGroups; track g) {
          <label class="check top">
            <input type="checkbox" [checked]="emailNotify().includes(g)" [disabled]="!verified" (change)="toggleEmail(g)" />
            <span class="opt">
              <span>{{ 'emailNotify.groups.' + g | t }}</span>
              <span class="help">{{ 'emailNotify.groupHelp.' + g | t }}</span>
            </span>
          </label>
        }
      </section>

      <section>
        <h2>{{ 'notifySettings.when' | t }} <app-help-tip [keys]="['notifySettings.whenHelp']" /></h2>
        <span class="time" role="group" [attr.aria-label]="'notifySettings.when' | t">
          <select [attr.aria-label]="'notifySettings.hour' | t" (change)="setTime(+$any($event.target).value * 60 + minOf())">
            @for (h of hourList; track h) { <option [value]="h" [selected]="hourOf() === h">{{ h }}</option> }
          </select>
          <span aria-hidden="true">:</span>
          <select [attr.aria-label]="'notifySettings.minute' | t" (change)="setTime(hourOf() * 60 + +$any($event.target).value)">
            @for (m of minuteList; track m) { <option [value]="m" [selected]="minOf() === m">{{ pad(m) }}</option> }
          </select>
        </span>
      </section>

      <section>
        <h2>{{ 'settings.dailyGroup' | t }} <app-help-tip [keys]="['settings.dailyGroupHelp']" /></h2>
        <div class="chips">
          @for (g of dailyGroups; track g) {
            <button type="button" [class.on]="dailyGroup() === g" [attr.aria-pressed]="dailyGroup() === g"
              (click)="pickGroup(g)">{{ 'settings.groups.' + g | t }}</button>
          }
        </div>
        <p class="help">{{ 'settings.groupHelp.' + dailyGroup() | t }}</p>
      </section>

      <!-- 期限前の通知は、期限別のときだけ効くので、そのときだけ出す（選んだ値は残る） -->
      @if (dailyGroup() === 'due') {
        <section>
          <h2>{{ 'settings.dueReminders' | t }} <app-help-tip [keys]="['settings.dueRemindersHelp']" /></h2>
          @for (b of reminderOptions; track b) {
            <label class="check">
              <input type="checkbox" [checked]="dueReminders().includes(b)" (change)="toggleReminder(b)" />
              {{ 'settings.reminder.' + b | t }}
            </label>
          }
        </section>
      }

    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 560px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; }
    section { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px; }
    h2 { font-size: 16px; margin: 0; }
    .time { display: inline-flex; align-items: center; gap: 6px; }
    select { min-height: 44px; font-size: 16px; padding: 0 10px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { min-height: 44px; padding: 0 18px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; align-self: flex-start; }
    .primary:disabled { background: var(--disabled); }
    .help { font-size: 12px; color: var(--text-muted); margin: 0; }
    .msg { font-size: 13px; color: var(--success-text); margin: 0 0 12px; }
    .msg.ng { color: var(--danger-text); }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; cursor: pointer; align-self: flex-start; }
    .link:disabled { color: var(--text-disabled); cursor: default; }
    .check { display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 14px; }
    .check input { width: 20px; height: 20px; margin: 0; }
    .check.top { align-items: flex-start; padding: 4px 0; }
    .check.top input { margin-top: 2px; flex: none; }
    .opt { display: flex; flex-direction: column; gap: 2px; }
  `,
})
export class NotifySettings implements OnInit {
  private authService = inject(AuthService);
  protected push = inject(PushService);

  readonly hourList = Array.from({ length: 24 }, (_, i) => i);
  readonly minuteList = Array.from({ length: 60 / DAILY_TIME_STEP }, (_, i) => i * DAILY_TIME_STEP);
  readonly dailyGroups = DAILY_GROUPS;
  readonly reminderOptions = REMINDER_BUCKETS;

  /** 毎朝のまとめの時刻（0時からの分） */
  time = signal(DEFAULT_DAILY_TIME);
  dailyGroup = signal<DailyGroup>('due');
  dueReminders = signal<ReminderBucket[]>(DEFAULT_DUE_REMINDERS);
  readonly emailGroups = EMAIL_GROUPS;
  emailNotify = signal<EmailGroup[]>([]);
  /** 送り先（ログインのメールアドレス）と、確認済みか（確認前は送れないので、チェックを押せなくする） */
  readonly email = auth.currentUser?.email ?? '';
  readonly verified = !!auth.currentUser?.emailVerified;

  msg = signal<{ key: string; ok: boolean } | null>(null);
  private msgTimer: ReturnType<typeof setTimeout> | undefined;
  pushBusy = signal(false);
  pushError = signal('');

  hourOf() { return Math.floor(this.time() / 60); }
  minOf() { return this.time() % 60; }
  pad(m: number) { return String(m).padStart(2, '0'); }

  async ngOnInit() {
    this.push.refresh();
    const p = this.authService.profile() ?? (await this.authService.fetchProfile());
    if (p) {
      this.time.set(p.dailyTime ?? DEFAULT_DAILY_TIME);
      this.dailyGroup.set(p.dailyGroup ?? 'due');
      this.dueReminders.set(p.dueReminders ?? DEFAULT_DUE_REMINDERS);
      this.emailNotify.set(p.emailNotify ?? []);
    }
  }

  setTime(t: number) {
    const prev = this.time();
    if (t === prev) return;
    this.time.set(t);
    this.persist({ dailyTime: t }, () => this.time.set(prev));
  }

  pickGroup(g: DailyGroup) {
    const prev = this.dailyGroup();
    if (g === prev) return;
    this.dailyGroup.set(g);
    this.persist({ dailyGroup: g }, () => this.dailyGroup.set(prev));
  }

  /** 期限前の区分を入れたり外したりする（並びは選択肢の順にそろえる） */
  toggleReminder(b: ReminderBucket) {
    const prev = this.dueReminders();
    const next = prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b];
    const list = REMINDER_BUCKETS.filter((x) => next.includes(x));
    this.dueReminders.set(list);
    this.persist({ dueReminders: list }, () => this.dueReminders.set(prev));
  }

  /** メールで受け取るまとまりを入れたり外したりする（並びは選択肢の順にそろえる） */
  toggleEmail(g: EmailGroup) {
    const prev = this.emailNotify();
    const next = prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g];
    const list = EMAIL_GROUPS.filter((x) => next.includes(x));
    this.emailNotify.set(list);
    this.persist({ emailNotify: list }, () => this.emailNotify.set(prev));
  }

  /** 先に画面を変えてから保存する。失敗したら画面を元に戻して知らせる */
  private async persist(changes: Changes, undo: () => void) {
    try {
      await this.authService.updateProfile(changes);
      this.flash('settings.saved', true);
    } catch (e) {
      console.error(e);
      undo();
      this.flash('common.saveError', false);
    }
  }

  private flash(key: string, ok: boolean) {
    this.msg.set({ key, ok });
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => this.msg.set(null), 3000);
  }

  /** プッシュ通知を、この端末で受け取る・受け取らない（すぐ反映） */
  async togglePush(on: boolean) {
    this.pushBusy.set(true);
    this.pushError.set('');
    try {
      if (on) await this.push.enable();
      else await this.push.disable();
    } catch (e) {
      console.error(e);
      this.pushError.set('push.failed');
    } finally {
      this.pushBusy.set(false);
    }
  }
}