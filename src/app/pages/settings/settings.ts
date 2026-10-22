import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { COMMON_TIMEZONES, formatDateTime, tzOffset } from '../../core/time/time';
import { I18nService, Lang, TPipe } from '../../i18n/i18n';
import { HelpTip } from '../../shared/help-tip';
import { PASSWORD_RULE } from '../login/login';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { Avatar } from '../../shared/avatar';
import { AvatarCropDialog } from '../../shared/avatar-crop-dialog';
import { PwField } from '../../shared/pw-field';
import { LogoutDialog } from '../../shared/logout-dialog';


type Section = 'general' | 'password' | 'email';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, Avatar, AvatarCropDialog, PwField, LogoutDialog],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    <main>
      <h1 class="page-title">{{ titles[section] | t }}</h1>
      @if (section === 'profile') {
        <section>
          <div class="avatar-row">
            <app-avatar [name]="displayName()" [uid]="uid" [photo]="photo()" [size]="64" />
            <div class="avatar-ops">
              <div class="row-start">
                <label class="ghost-btn" [class.disabled]="photoBusy()">{{ 'settings.photoChange' | t }}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/heic" hidden [disabled]="photoBusy()"
                    (change)="onPhoto($event)" />
                </label>
                @if (photo()) {
                  <button type="button" class="link" [disabled]="photoBusy()" (click)="removePhoto()">
                    {{ 'settings.photoRemove' | t }}</button>
                }
              </div>
              <p class="help">{{ 'settings.photoHelp' | t }}</p>
              @if (photoMsg()) { <p class="msg" [class.ng]="photoMsg() !== 'settings.photoSaved'">{{ photoMsg() | t }}</p> }
            </div>
          </div>
          <label class="field">{{ 'settings.displayName' | t }}
            <input [ngModel]="displayName()" (ngModelChange)="displayName.set($event)" maxlength="50" />
          </label>
        </section>
      }

      @if (section === 'preferences') {
        <section>
          <h2>{{ 'settings.language' | t }}</h2>
          <div class="chips">
            <button type="button" [class.on]="language() === 'ja'" (click)="language.set('ja')">日本語</button>
            <button type="button" [class.on]="language() === 'en'" (click)="language.set('en')">English</button>
          </div>
        </section>
        <section>
          <h2>{{ 'settings.defaultView' | t }}</h2>
          <div class="chips">
            <button type="button" [class.on]="defaultView() === 'list'" (click)="defaultView.set('list')">{{ 'tabs.list' | t }}</button>
            <button type="button" [class.on]="defaultView() === 'board'" (click)="defaultView.set('board')">{{ 'tabs.board' | t }}</button>
          </div>
        </section>
        <section>
          <h2>{{ 'settings.timeZone' | t }} <app-help-tip [keys]="['settings.tzHelp']" /></h2>
          <select [ngModel]="timeZone()" (ngModelChange)="timeZone.set($event)">
            <optgroup [label]="'settings.tzCommon' | t">
              @for (z of commonZones; track z.value) { <option [value]="z.value">{{ z.label }}</option> }
            </optgroup>
            <optgroup [label]="'settings.tzAll' | t">
              @for (z of allZones; track z.value) { <option [value]="z.value">{{ z.label }}</option> }
            </optgroup>
          </select>
          <p class="help">{{ 'settings.tzNow' | t: { t: nowInZone() } }}</p>
        </section>
      }

      @if (section === 'account') {
        <section>
          <h2>{{ 'account.email' | t }}</h2>
          <p class="current">{{ email }}</p>
          @if (isPasswordUser) {
            @if (emailSent(); as to) {
              <p class="msg" role="status">{{ 'account.emailSent' | t: { email: to } }}</p>
            } @else {
              <label class="field">{{ 'account.newEmail' | t }}
                <input type="email" [(ngModel)]="newEmail" autocomplete="email" />
              </label>
              <label class="field">{{ 'settings.currentPw' | t }}
                <app-pw-field><input type="password" [(ngModel)]="emailPw" autocomplete="current-password" /></app-pw-field>
              </label>
              <div class="row">
                @if (msg()?.section === 'email') { <span class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</span> }
                <button type="button" class="primary" [disabled]="busy() || !newEmail.trim() || !emailPw"
                  (click)="changeEmail()">{{ 'account.sendLink' | t }}</button>
              </div>
              <p class="help">{{ 'account.emailHelp' | t }}</p>
            }
          } @else {
            <p class="help">{{ 'account.googleEmail' | t }}</p>
          }
        </section>

        <section>
          <h2>{{ 'settings.password' | t }}</h2>
          @if (isPasswordUser) {
            <label class="field">{{ 'settings.currentPw' | t }}
              <app-pw-field><input type="password" [(ngModel)]="currentPw" autocomplete="current-password" /></app-pw-field>
            </label>
            <label class="field">{{ 'settings.newPw' | t }}
              <app-pw-field><input type="password" [(ngModel)]="newPw" autocomplete="new-password" minlength="8" /></app-pw-field>
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

        <section>
          <h2>{{ 'common.logout' | t }}</h2>
          <button type="button" class="ghost-btn" (click)="logoutOpen.set(true)">{{ 'common.logout' | t }}</button>
        </section>

        <!-- 危ない操作は一番下に、赤い枠で -->
        <section class="danger-zone">
          <h2>{{ 'deleteAccount.title' | t }}</h2>
          <p class="help">{{ 'deleteAccount.entryHelp' | t }}</p>
          <a routerLink="/settings/account/delete" class="danger-link">{{ 'deleteAccount.open' | t }}</a>
        </section>
      }

      @if (section === 'intro') {
        <section>
          <p class="help">{{ 'intro.settingsHelp' | t }}</p>
          <button type="button" class="primary start-btn" (click)="startIntro()">{{ 'intro.start' | t }}</button>
        </section>
      }

      @if (msg()?.section === 'general') {
        <p class="msg" [class.ng]="!msg()!.ok">{{ msg()!.key | t }}</p>
      }
      @if (dirty()) {
        <div class="savebar" role="status">
          <span>{{ 'settings.unsaved' | t }}</span>
          <button type="button" class="link" [disabled]="busy()" (click)="discard()">{{ 'settings.discard' | t }}</button>
          <button type="button" class="primary" [disabled]="busy() || !displayName().trim()" (click)="save()">
            {{ 'settings.saveChanges' | t }}</button>
        </div>
      }
    </main>
    @if (cropFile(); as f) {
      <app-avatar-crop-dialog [file]="f" (done)="savePhoto($event)" (cancel)="cropFile.set(null)" />
    }
    @if (logoutOpen()) { <app-logout-dialog (cancel)="logoutOpen.set(false)" /> }
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 640px; padding: 0 0 48px; }
    h1 { font-size: 20px; }
    section { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px; }
    h2 { font-size: 16px; margin: 0; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    input, select { min-height: 44px; font-size: 16px; padding: 0 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips button { min-height: 44px; padding: 0 18px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .row { display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .help { font-size: 12px; color: var(--text-muted); margin: 0; }
    .msg { font-size: 13px; color: var(--success-text); margin: 0; }
    .msg.ng { color: var(--danger-text); }
    .link { background: none; border: none; color: var(--primary); }
    .savebar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px; margin: 0; border-radius: 8px; background: var(--warning-bg); border-top: 1px solid var(--warning-border);
      padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    .savebar span { flex: 1; font-size: 13px; }
    .check { display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 14px; }
    .check input { width: 20px; height: 20px; min-height: 0; padding: 0; }
    .to-notify { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 16px; margin-bottom: 16px;
      border: 1px solid var(--border); border-radius: 10px; color: var(--text); text-decoration: none; font-size: 18px; }
    .to-notify:hover { background: var(--surface-alt); }
    .to-body { flex: 1; display: flex; flex-direction: column; gap: 2px; font-size: 15px; }
    .row-start { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .danger-link { align-self: flex-start; display: inline-flex; align-items: center; min-height: 44px;
      color: var(--danger-text); text-decoration: none; font-size: 14px; }
    .danger-link:hover { text-decoration: underline; }
    .avatar-row { display: flex; align-items: center; gap: 16px; }
    .avatar-ops { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ghost-btn { display: inline-flex; align-items: center; min-height: 40px; padding: 0 14px; border: 1px solid var(--primary);
      border-radius: 8px; color: var(--primary); font-size: 14px; cursor: pointer; }
    .ghost-btn:hover { background: var(--primary-bg); }
    .ghost-btn.disabled { opacity: 0.5; pointer-events: none; }
    .page-title { font-size: 18px; margin: 0 0 12px; }
    .current { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .danger-zone { border-color: var(--danger); }
    .ghost-btn { align-self: flex-start; background: var(--surface); }
    .start-btn { align-self: flex-start; }
  `,
})
export class Settings implements OnInit {
  /** このページで出す欄（道の data で決まる。入れ物の索引の1項目にあたる） */
  readonly section = inject(ActivatedRoute).snapshot.data['section'] as 'profile' | 'preferences' | 'account' | 'intro';
  /** ページの見出し（左の索引と同じ名前） */
  readonly titles: Record<string, string> = {
    profile: 'settings.profile', preferences: 'settingsNav.preferences',
    account: 'settingsNav.account', intro: 'intro.settingsTitle',
  };

  // ---- メールアドレスの変更 ----
  readonly email = auth.currentUser?.email ?? '';
  newEmail = '';
  emailPw = '';
  /** 確認メールを送った先（送ったら、欄の代わりに知らせを出す） */
  emailSent = signal<string | null>(null);
  /** ログアウトの確かめの窓 */
  logoutOpen = signal(false);

  async changeEmail() {
    const to = this.newEmail.trim();
    if (to.toLowerCase() === this.email.toLowerCase()) {
      this.msg.set({ section: 'email', key: 'account.same', ok: false });
      return;
    }
    this.busy.set(true);
    this.msg.set(null);
    try {
      await this.authService.changeEmail(this.emailPw, to);
      this.emailPw = '';
      this.emailSent.set(to);
    } catch (e) {
      console.error(e);
      const code = (e as { code?: string }).code ?? '';
      const key = code.includes('invalid-credential') || code.includes('wrong-password') ? 'settings.pwWrong'
        : code.includes('invalid-email') ? 'account.invalidEmail'
          : code.includes('email-already-in-use') ? 'account.inUse'
            : code.includes('too-many-requests') ? 'account.tooMany'
              : 'common.saveError';
      this.msg.set({ section: 'email', key, ok: false });
    } finally {
      this.busy.set(false);
    }
  }

  async logout() {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
  private authService = inject(AuthService);
  private router = inject(Router);

  /**
   * イントロダクションを始める：ホームへ移り、ようこその箱を出してもらう。
   * プロジェクトがあっても出すよう、印（intro）を添える。見本を作る・開くは、箱の中のボタンに任せる
   */
  startIntro() {
    this.router.navigate(['/'], { state: { intro: true } });
  }
  protected i18n = inject(I18nService);

  readonly uid = auth.currentUser!.uid;
  /** 自分のアイコンの写真（入れたもの → なければ Google の写真） */
  photo = computed(() => this.authService.myPhoto());
  photoBusy = signal(false);
  photoMsg = signal('');

  /** 範囲を選ぶ窓に渡す写真（null＝窓は閉じている） */
  cropFile = signal<File | null>(null);

  /** 写真を選んだら、範囲を選ぶ窓を開く */
  onPhoto(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 同じ写真をもう一度選んでも、選んだことになるように
    if (!file) return;
    this.photoMsg.set('');
    this.cropFile.set(file);
  }

  /** 範囲を決めたら、上げる */
  async savePhoto(blob: Blob) {
    this.cropFile.set(null);
    this.photoBusy.set(true);
    this.photoMsg.set('');
    try {
      await this.authService.setPhoto(blob);
      this.photoMsg.set('settings.photoSaved');
    } catch (err) {
      console.error(err);
      this.photoMsg.set('common.saveError');
    } finally {
      this.photoBusy.set(false);
    }
  }

  async removePhoto() {
    this.photoBusy.set(true);
    this.photoMsg.set('');
    try {
      await this.authService.removePhoto();
    } catch (err) {
      console.error(err);
      this.photoMsg.set('common.saveError');
    } finally {
      this.photoBusy.set(false);
    }
  }

  readonly isPasswordUser = this.authService.isPasswordUser();
  readonly commonZones = COMMON_TIMEZONES.map((z) => ({ value: z, label: `${z}（${tzOffset(z)}）` }));
  readonly allZones = Intl.supportedValuesOf('timeZone').map((z) => ({ value: z, label: `${z}（${tzOffset(z)}）` }));

  // 画面上の値（保存するまでは反映しない）
  displayName = signal('');
  language = signal<Lang>('ja');
  timeZone = signal('Asia/Tokyo');
  defaultView = signal<'list' | 'board'>('list');
  // 保存済みの値（変更があるかの比較用）
  private saved = signal({
    displayName: '', language: 'ja' as Lang, timeZone: 'Asia/Tokyo', defaultView: 'list' as 'list' | 'board',
  });

  currentPw = '';
  newPw = '';
  busy = signal(false);
  msg = signal<{ section: Section; key: string; ok: boolean } | null>(null);

  nowInZone = computed(() => formatDateTime(new Date(), this.timeZone(), this.i18n.lang()));
  dirty = computed(() => {
    const s = this.saved();
    return this.displayName().trim() !== s.displayName
      || this.language() !== s.language
      || this.timeZone() !== s.timeZone
      || this.defaultView() !== s.defaultView;
  });

  async ngOnInit() {
    const p = this.authService.profile() ?? (await this.authService.fetchProfile());
    if (p) {
      this.saved.set({
        displayName: p.displayName, language: p.language, timeZone: p.timeZone, defaultView: p.defaultView ?? 'list',
      });
      this.discard();
    }
  }
  /** 変えた項目だけをまとめて保存する */
  async save() {
    const s = this.saved();
    const changes: {
      displayName?: string; language?: Lang; timeZone?: string; defaultView?: 'list' | 'board';
    } = {};
    const name = this.displayName().trim();
    if (name !== s.displayName) changes.displayName = name;
    if (this.language() !== s.language) changes.language = this.language();
    if (this.timeZone() !== s.timeZone) changes.timeZone = this.timeZone();
    if (this.defaultView() !== s.defaultView) changes.defaultView = this.defaultView();
    await this.run('general', async () => {
      await this.authService.updateProfile(changes);
      this.saved.set({
        displayName: name, language: this.language(), timeZone: this.timeZone(), defaultView: this.defaultView(),
      });
    });

  }

  /** 保存済みの値に戻す */
  discard() {
    const s = this.saved();
    this.displayName.set(s.displayName);
    this.language.set(s.language);
    this.timeZone.set(s.timeZone);
    this.defaultView.set(s.defaultView);
    this.msg.set(null);
  }

  /** タブを閉じる・再読み込みするときの確認 */
  onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.dirty()) e.preventDefault();
  }

  async changePassword() {
    if (!PASSWORD_RULE.test(this.newPw)) {
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

