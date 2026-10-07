import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { COMMON_TIMEZONES, formatDateTime, tzOffset } from '../../core/time';
import { I18nService, Lang, TPipe } from '../../i18n/i18n';

type Section = 'profile' | 'language' | 'timeZone' | 'password';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'common.back' | t }}</a></header>
    <main>
      <h1>{{ 'settings.title' | t }}</h1>

      <section>
        <h2>{{ 'settings.profile' | t }}</h2>
        <label class="field">{{ 'settings.displayName' | t }}
          <input [(ngModel)]="displayName" maxlength="50" />
        </label>
        <div class="row">
          @if (msg()?.section === 'profile') { <span class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</span> }
          <button type="button" class="primary" [disabled]="busy() || !displayName.trim()" (click)="saveProfile()">
            {{ 'settings.save' | t }}</button>
        </div>
      </section>

      <section>
        <h2>{{ 'settings.language' | t }}</h2>
        <div class="chips">
          <button type="button" [class.on]="i18n.lang() === 'ja'" (click)="saveLanguage('ja')">日本語</button>
          <button type="button" [class.on]="i18n.lang() === 'en'" (click)="saveLanguage('en')">English</button>
        </div>
        @if (msg()?.section === 'language') { <p class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</p> }
      </section>

      <section>
        <h2>{{ 'settings.timeZone' | t }}</h2>
        <p class="help">{{ 'settings.tzHelp' | t }}</p>
        <select [ngModel]="timeZone()" (ngModelChange)="saveTimeZone($event)">
          <optgroup [label]="'settings.tzCommon' | t">
            @for (z of commonZones; track z.value) { <option [value]="z.value">{{ z.label }}</option> }
          </optgroup>
          <optgroup [label]="'settings.tzAll' | t">
            @for (z of allZones; track z.value) { <option [value]="z.value">{{ z.label }}</option> }
          </optgroup>
        </select>
        <p class="help">{{ 'settings.tzNow' | t: { t: nowInZone() } }}</p>
        @if (msg()?.section === 'timeZone') { <p class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</p> }
      </section>

      <section>
        <h2>{{ 'settings.password' | t }}</h2>
        @if (isPasswordUser) {
          <label class="field">{{ 'settings.currentPw' | t }}
            <input type="password" [(ngModel)]="currentPw" autocomplete="current-password" />
          </label>
          <label class="field">{{ 'settings.newPw' | t }}
            <input type="password" [(ngModel)]="newPw" autocomplete="new-password" minlength="6" />
          </label>
          <div class="row">
            @if (msg()?.section === 'password') { <span class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</span> }
            <button type="button" class="primary" [disabled]="busy() || !currentPw || !newPw" (click)="changePassword()">
              {{ 'settings.changePw' | t }}</button>
          </div>
        } @else {
          <p class="help">{{ 'settings.googleManaged' | t }}</p>
        }
      </section>
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid #ddd; }
    main { max-width: 560px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; }
    section { border: 1px solid #eee; border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px; }
    h2 { font-size: 16px; margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    input, select { min-height: 44px; font-size: 16px; padding: 0 12px; }
    .chips { display: flex; gap: 8px; }
    .chips button { min-height: 44px; padding: 0 18px; border: 1px solid #ccc; background: #fff;
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: #1565c0; color: #fff; border-color: #1565c0; }
    .row { display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
    .primary { min-height: 44px; padding: 0 20px; background: #1565c0; color: #fff; border: none;
      border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: #9e9e9e; }
    .help { font-size: 12px; color: #666; margin: 0; }
    .msg { font-size: 13px; color: #2e7d32; margin: 0; }
    .msg.ng { color: #c62828; }
    .link { background: none; border: none; color: #1565c0; }
  `,
})
export class Settings implements OnInit {
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  readonly isPasswordUser = this.authService.isPasswordUser();
  readonly commonZones = COMMON_TIMEZONES.map((z) => ({ value: z, label: `${z}（${tzOffset(z)}）` }));
  readonly allZones = Intl.supportedValuesOf('timeZone').map((z) => ({ value: z, label: `${z}（${tzOffset(z)}）` }));

  displayName = '';
  currentPw = '';
  newPw = '';
  timeZone = signal('Asia/Tokyo');
  busy = signal(false);
  msg = signal<{ section: Section; key: string; ok: boolean } | null>(null);

  nowInZone = computed(() => formatDateTime(new Date(), this.timeZone(), this.i18n.lang()));

  async ngOnInit() {
    const p = this.authService.profile() ?? (await this.authService.fetchProfile());
    if (p) {
      this.displayName = p.displayName;
      this.timeZone.set(p.timeZone);
    }
  }

  saveProfile() {
    return this.run('profile', () => this.authService.updateProfile({ displayName: this.displayName.trim() }));
  }

  saveLanguage(lang: Lang) {
    return this.run('language', () => this.authService.updateProfile({ language: lang }));
  }

  saveTimeZone(tz: string) {
    this.timeZone.set(tz);
    return this.run('timeZone', () => this.authService.updateProfile({ timeZone: tz }));
  }

  async changePassword() {
    if (this.newPw.length < 6) {
      this.msg.set({ section: 'password', key: 'settings.pwWeak', ok: false });
      return;
    }
    this.busy.set(true);
    this.msg.set(null);
    try {
      await this.authService.changePassword(this.currentPw, this.newPw);
      this.currentPw = '';
      this.newPw = '';
      this.msg.set({ section: 'password', key: 'settings.pwChanged', ok: true });
    } catch (e) {
      console.error(e);
      const code = (e as { code?: string }).code ?? '';
      const key = code.includes('invalid-credential') || code.includes('wrong-password')
        ? 'settings.pwWrong'
        : code.includes('weak-password') ? 'settings.pwWeak' : 'common.saveError';
      this.msg.set({ section: 'password', key, ok: false });
    } finally {
      this.busy.set(false);
    }
  }

  private async run(section: Section, fn: () => Promise<void>) {
    this.busy.set(true);
    this.msg.set(null);
    try {
      await fn();
      this.msg.set({ section, key: 'settings.saved', ok: true });
    } catch (e) {
      console.error(e);
      this.msg.set({ section, key: 'common.saveError', ok: false });
    } finally {
      this.busy.set(false);
    }
  }
}