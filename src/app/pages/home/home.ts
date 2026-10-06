import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-home',
  imports: [TPipe],
  template: `
    <main style="padding:16px">
      <p>{{ 'home.welcome' | t: { name: name() } }}</p>
      <button type="button" (click)="logout()">{{ 'home.logout' | t }}</button>
    </main>`,
})
export class Home {
  private authService = inject(AuthService);
  private router = inject(Router);
  name = computed(() => this.authService.user()?.displayName ?? this.authService.user()?.email ?? '');

  async logout() {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
}