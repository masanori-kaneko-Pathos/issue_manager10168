import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { I18nService, TPipe } from '../../i18n/i18n';

/** パスワードの決まり：8文字以上、英字と数字を両方含む（Firebaseの設定と同じ内容を、画面でも先に確かめる） */
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
@Component({
  selector: 'app-login',
  imports: [FormsModule, TPipe],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private authService = inject(AuthService);
  private router = inject(Router);
  protected i18n = inject(I18nService);

  email = '';
  password = '';
  mode = signal<'login' | 'signup' | 'reset'>('login');
  displayName = '';
  resetSent = signal(false);
  error = signal('');
  busy = signal(false);

  setMode(m: 'login' | 'signup' | 'reset') {
    this.mode.set(m);
    this.error.set('');
    this.resetSent.set(false);
  }
  submitEmail() {
    if (this.mode() === 'signup') {
      if (!this.displayName.trim()) {
        this.error.set('login.errors.no-name');
        return;
      }
      if (!PASSWORD_RULE.test(this.password)) {
        this.error.set('login.errors.weak-password');
        return;
      }
    }
    return this.run(() =>
      this.mode() === 'login'
        ? this.authService.loginWithEmail(this.email, this.password)
        : this.authService.signUpWithEmail(this.email, this.password, this.displayName.trim()));
  }

  /** 再設定のメールを頼む。登録の有無にかかわらず、同じ「送りました」を出す */
  async sendReset() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.authService.sendPasswordReset(this.email.trim());
      this.resetSent.set(true);
    } catch (e) {
      console.error(e);
      const code = ((e as { code?: string }).code ?? '').replace('auth/', '');
      const key = `login.errors.${code}`;
      this.error.set(this.i18n.has(key) ? key : 'login.errors.default');
    } finally {
      this.busy.set(false);
    }
  }
  google() {
    return this.run(() => this.authService.loginWithGoogle());
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await fn();
      await this.router.navigateByUrl('/');
    } catch (e) {
      const code = ((e as { code?: string }).code ?? '').replace('auth/', '');
      if (code === 'popup-closed-by-user') return;
      const key = `login.errors.${code}`;
      this.error.set(this.i18n.has(key) ? key : 'login.errors.default');
    } finally {
      this.busy.set(false);
    }
  }
}