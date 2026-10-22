import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { PushService } from '../../core/notification/push.service';
import { DAILY_GROUPS, DAILY_TIME_STEP, DEFAULT_DAILY_TIME, DailyGroup, EMAIL_GROUPS, EmailGroup } from '../../core/models';
import { auth } from '../../core/firebase';
import { DEFAULT_DUE_REMINDERS, ReminderBucket } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { HelpTip } from '../../shared/help-tip';
import { ChipMenu } from '../../shared/chip-menu';

type Changes = Parameters<AuthService['updateProfile']>[0];

/** 期限前の通知の「何日前から」（上から順にしか付かない形を、1つの選択にしたもの） */
type DueLevel = 'none' | 'today' | 'd1' | 'd3';
const DUE_LEVELS: Record<DueLevel, ReminderBucket[]> = {
  none: [], today: ['today'], d1: ['today', 'tomorrow'], d3: ['today', 'tomorrow', 'in3'],
};

/**
 * 通知設定：プッシュ（この端末）、毎日のまとめ（届ける・時刻・形・期限前）、メール。
 * 変えたらすぐ保存する
 */
@Component({
  selector: 'app-notify-settings',
  imports: [TPipe, HelpTip, ChipMenu],
  template: `
    <main>
      <h1>{{ 'notifySettings.title' | t }}</h1>
      @if (msg(); as m) { <p class="msg" [class.ng]="!m.ok" role="status">{{ m.key | t }}</p> }

      <!-- プッシュ（この端末） -->
      <section>
        <div class="sw-row">
          <div class="sw-text">
            <h2>{{ 'push.title' | t }} <app-help-tip [keys]="['push.help']" /></h2>
            <p class="help">{{ pushText() | t }}</p>
          </div>
          <input type="checkbox" role="switch" class="switch" [attr.aria-label]="'push.title' | t"
            [checked]="push.state() === 'on'" [disabled]="pushBusy() || !pushUsable()" (change)="togglePush($event)" />
        </div>
        @if (pushError()) { <p class="msg ng">{{ pushError() | t }}</p> }
      </section>

      <!-- 毎日のまとめ：オンのときだけ、時刻・形・期限前を出す -->
      <section>
        <div class="sw-row">
          <div class="sw-text">
            <h2>{{ 'notifySettings.daily' | t }} <app-help-tip [keys]="['notifySettings.whenHelp']" /></h2>
            <p class="help">{{ (dailyOn() ? 'notifySettings.dailyOnHelp' : 'notifySettings.dailyOffHelp') | t }}</p>
          </div>
          <input type="checkbox" role="switch" class="switch" [attr.aria-label]="'notifySettings.daily' | t"
            [checked]="dailyOn()" (change)="setDailyOn($event)" />
        </div>
        <div class="fold-body daily" [class.open]="dailyOn()" [attr.inert]="dailyOn() ? null : ''">
          <div>
          <div class="rows">
            <div class="row-item">
              <span class="lbl">{{ 'notifySettings.time' | t }}</span>
              <!-- チップのプルダウン（ブラウザの select は、開いた一覧の見た目をアプリにそろえられないため） -->
              <span class="time" role="group" [attr.aria-label]="'notifySettings.time' | t">
                <app-chip-menu [label]="'notifySettings.hour' | t" [options]="hourMenu()" [value]="hourOf()"
                  (picked)="setTime(+$event * 60 + minOf())" />
                <app-chip-menu [label]="'notifySettings.minute' | t" [options]="minuteMenu()" [value]="minOf()"
                  (picked)="setTime(hourOf() * 60 + +$event)" />
              </span>
            </div>
            <div class="row-item">
              <app-chip-menu [label]="'notifySettings.group' | t" [options]="groupMenu()" [value]="dailyGroup()"
                (picked)="pickGroup($any($event))" />
              <app-help-tip [keys]="['settings.dailyGroupHelp']" />
            </div>
            <p class="help">{{ 'settings.groupHelp.' + dailyGroup() | t }}</p>
            <!-- 期限前の通知は、期限別のときだけ効くので、そのときだけ出す（選んだ値は残る） -->
            @if (dailyGroup() === 'due') {
              <div class="row-item">
                <app-chip-menu [label]="'notifySettings.due' | t" [options]="dueMenu()" [value]="dueLevel()"
                  (picked)="pickDueLevel($any($event))" />
                <app-help-tip [keys]="['settings.dueRemindersHelp']" />
              </div>
            }
          </div>
          </div>
        </div>
      </section>

      <!-- メール：たためる。たたんだままでも、何を受け取るか1行でわかる -->
      <section>
        <h2 class="fold-h">
          <button type="button" class="fold" [attr.aria-expanded]="emailOpen()" (click)="emailOpen.set(!emailOpen())">
            <span>{{ 'emailNotify.title' | t }}</span>
            <span class="tri" [class.up]="emailOpen()" aria-hidden="true">▾</span>
          </button>
        </h2>
        <p class="help">{{ emailSummary() }}</p>
        <!-- たたむ・開く：高さをなめらかに伸び縮み。中に何も付いていない箱を挟む（.rows の余白と線まで縮めるため） -->
        <div class="fold-body mail" [class.open]="emailOpen()" [attr.inert]="emailOpen() ? null : ''">
          <div>
          <div class="rows">
            <p class="help">{{ 'emailNotify.help' | t }}</p>
            <p class="help">{{ 'emailNotify.to' | t: { email: email } }}</p>
            @if (!verified) { <p class="msg ng">{{ 'emailNotify.unverified' | t }}</p> }
            @for (g of emailGroups; track g) {
              <label class="sw-row item">
                <span class="opt">
                  <span>{{ 'emailNotify.groups.' + g | t }}</span>
                  <span class="help">{{ 'emailNotify.groupHelp.' + g | t }}</span>
                </span>
                <input type="checkbox" role="switch" class="switch" [checked]="emailNotify().includes(g)"
                  [disabled]="!verified" (change)="toggleEmail(g)" />
              </label>
            }
          </div>
          </div>
        </div>
      </section>
    </main>
  `,
  styles: `
    main { max-width: 640px; padding: 0 0 48px; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    section { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px; }
    h2 { font-size: 16px; margin: 0; }
    /* 左に見出しと説明、右端にスイッチ */
    .sw-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .sw-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .rows { display: flex; flex-direction: column; gap: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .row-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .lbl { font-size: 14px; color: var(--text-secondary); }
    .time { display: inline-flex; align-items: center; gap: 6px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 0; }
    .msg { font-size: 13px; color: var(--success-text); margin: 0 0 12px; }
    .msg.ng { color: var(--danger-text); }
    /* メールの見出し：押すとたたむ・開く（三角はホームと同じく、1つの絵を回す） */
    .fold-h { margin: 0; }
    .fold { display: inline-flex; align-items: center; gap: 8px; padding: 2px 4px; margin-left: -4px; border: none;
      border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; }
    .fold:hover { background: var(--surface-alt); }
    .tri { display: inline-block; font-size: 12px; color: var(--text-muted); transition: rotate 160ms var(--ease-out); }
    .tri.up { rotate: 180deg; }
    .item { padding: 6px 0; cursor: pointer; }
    .opt { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
    /* メールの欄：たたんでいる間も置いたままなので、section の gap（10px）が下に余らないよう打ち消し、
       開いたときは中で同じだけ空ける（中の箱は overflow: hidden なので、余白は外へはみ出さない） */
    .fold-body.mail { margin-top: -10px; }
    .fold-body.mail .rows { margin-top: 10px; }
    .fold-body.daily { margin-top: -10px; }
    .fold-body.daily .rows { margin-top: 10px; }
  `,
})
export class NotifySettings implements OnInit {
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  protected push = inject(PushService);

  readonly hourList = Array.from({ length: 24 }, (_, i) => i);
  readonly minuteList = Array.from({ length: 60 / DAILY_TIME_STEP }, (_, i) => i * DAILY_TIME_STEP);
  /** 届く時刻のチップの中身（時は 0〜23、分は 00・10…50） */
  hourMenu = computed(() => this.hourList.map((h) => ({ value: h, label: String(h) })));
  minuteMenu = computed(() => this.minuteList.map((m) => ({ value: m, label: this.pad(m) })));
  readonly emailGroups = EMAIL_GROUPS;

  /** 毎日のまとめを届けるか（届けない＝ dailyTime が 'off'） */
  dailyOn = signal(true);
  /** 届ける時刻（0時からの分）。届けないにしても、オンに戻したときのために覚えておく */
  time = signal(DEFAULT_DAILY_TIME);
  dailyGroup = signal<DailyGroup>('due');
  dueReminders = signal<ReminderBucket[]>(DEFAULT_DUE_REMINDERS);
  emailNotify = signal<EmailGroup[]>([]);
  /** メールの箱を開いているか（最初はたたむ） */
  emailOpen = signal(false);
  /** 送り先（ログインのメールアドレス）と、確認済みか（確認前は送れないので、スイッチを押せなくする） */
  readonly email = auth.currentUser?.email ?? '';
  readonly verified = !!auth.currentUser?.emailVerified;

  msg = signal<{ key: string; ok: boolean } | null>(null);
  private msgTimer: ReturnType<typeof setTimeout> | undefined;
  pushBusy = signal(false);
  pushError = signal('');

  /** プッシュの今の様子の一言 */
  pushText = computed(() => {
    const s = this.push.state();
    return s === 'on' ? 'push.on' : s === 'off' ? 'push.off' : s === 'blocked' ? 'push.blocked' : 'push.unsupported';
  });
  /** スイッチを押せるか（ブラウザで拒否中・使えない端末では押せない） */
  pushUsable = computed(() => this.push.state() === 'on' || this.push.state() === 'off');

  /** プルダウンの中身（言語を切り替えても、すぐ言葉が変わるように computed で） */
  groupMenu = computed(() => DAILY_GROUPS.map((g) => ({ value: g, label: this.i18n.t('settings.groups.' + g) })));
  dueMenu = computed(() => (Object.keys(DUE_LEVELS) as DueLevel[])
    .map((l) => ({ value: l, label: this.i18n.t('notifySettings.dueLevels.' + l) })));
  /** 今の期限前の通知を、「何日前から」に読み替える（古い形で途中が抜けていても、一番先の区分で決める） */
  dueLevel = computed<DueLevel>(() => {
    const r = this.dueReminders();
    return r.includes('in3') ? 'd3' : r.includes('tomorrow') ? 'd1' : r.includes('today') ? 'today' : 'none';
  });
  /** メールの箱をたたんだときの1行（「受け取る：毎日のまとめ・コメント」） */
  emailSummary = computed(() => {
    const list = this.emailNotify();
    if (!list.length) return this.i18n.t('emailNotify.none');
    const sep = this.i18n.lang() === 'ja' ? '・' : ', ';
    return this.i18n.t('emailNotify.summary', {
      list: list.map((g) => this.i18n.t('emailNotify.groups.' + g)).join(sep),
    });
  });

  hourOf() { return Math.floor(this.time() / 60); }
  minOf() { return this.time() % 60; }
  pad(m: number) { return String(m).padStart(2, '0'); }

  async ngOnInit() {
    this.push.refresh();
    const p = this.authService.profile() ?? (await this.authService.fetchProfile());
    if (p) {
      this.dailyOn.set(p.dailyTime !== 'off');
      this.time.set(typeof p.dailyTime === 'number' ? p.dailyTime : DEFAULT_DAILY_TIME);
      this.dailyGroup.set(p.dailyGroup ?? 'due');
      this.dueReminders.set(p.dueReminders ?? DEFAULT_DUE_REMINDERS);
      this.emailNotify.set(p.emailNotify ?? []);
    }
  }

  /** 届ける・届けない。届けるに戻したら、覚えている時刻で届ける */
  setDailyOn(e: Event) {
    const el = e.target as HTMLInputElement;
    const on = el.checked;
    this.dailyOn.set(on);
    this.persist({ dailyTime: on ? this.time() : 'off' }, () => {
      this.dailyOn.set(!on);
      el.checked = !on;
    });
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

  /** 期限前の通知：「何日前から」を選ぶと、そこまでの区分を全部付ける（上から順にしか付かない） */
  pickDueLevel(l: DueLevel) {
    const prev = this.dueReminders();
    const list = DUE_LEVELS[l];
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

  /**
   * プッシュのスイッチ。オンは、ブラウザの許可の窓 → 登録。終わったら、スイッチを本当の状態に合わせ直す
   * （許可されなかったときに、スイッチだけオンのまま残らないように）
   */
  async togglePush(e: Event) {
    const el = e.target as HTMLInputElement;
    this.pushBusy.set(true);
    this.pushError.set('');
    try {
      if (el.checked) await this.push.enable();
      else await this.push.disable();
    } catch (err) {
      console.error(err);
      this.pushError.set('push.failed');
    } finally {
      this.pushBusy.set(false);
      el.checked = this.push.state() === 'on';
    }
  }
}