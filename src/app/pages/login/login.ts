import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { I18nService, TPipe } from '../../i18n/i18n';

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
  mode = signal<'login' | 'signup'>('login');
  error = signal('');
  busy = signal(false);

  toggleMode() {
    this.mode.update((m) => (m === 'login' ? 'signup' : 'login'));
    this.error.set('');
  }
  submitEmail() {
    return this.run(() =>
      this.mode() === 'login'
        ? this.authService.loginWithEmail(this.email, this.password)
        : this.authService.signUpWithEmail(this.email, this.password));
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