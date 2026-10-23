import { Component, inject, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { TPipe } from '../i18n/i18n';

/** ログアウトの確かめ（ヘッダーのメニューと、アカウント設定から使う）。確定したら、ログインの画面へ */
@Component({
  selector: 'app-logout-dialog',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'logout.title' | t">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <h2>{{ 'logout.title' | t }}</h2>
      <p class="help">{{ 'logout.help' | t }}</p>
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy()" (click)="confirm()">{{ 'common.logout' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
  `,
})
export class LogoutDialog {
  private authService = inject(AuthService);
  private router = inject(Router);
  cancel = output<void>();
  busy = signal(false);

  async confirm() {
    this.busy.set(true);
    try {
      // プッシュの登録を外す処理は、logout の中に入っている
      await this.authService.logout();
      await this.router.navigateByUrl('/login');
    } finally {
      this.busy.set(false);
    }
  }
}