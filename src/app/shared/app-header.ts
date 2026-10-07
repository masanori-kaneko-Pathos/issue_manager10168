import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { TPipe } from '../i18n/i18n';

@Component({
  selector: 'app-header',
  imports: [RouterLink, TPipe],
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <header class="app-header">
      <a routerLink="/" class="brand">{{ 'app.title' | t }}</a>
      <span class="spacer"></span>
      <div class="account">
        <button type="button" class="account-btn" [attr.aria-expanded]="open()"
          [attr.aria-label]="'menu.account' | t" (click)="open.set(!open())">
          @if (photo()) {
            <img [src]="photo()" alt="" referrerpolicy="no-referrer" />
          } @else {
            <span class="initial">{{ initial() }}</span>
          }
          <span class="gear" aria-hidden="true">⚙</span>
        </button>

        @if (open()) {
          <div class="backdrop" (click)="open.set(false)"></div>
          <div class="menu" role="menu">
            <div class="who">
              <strong>{{ name() }}</strong>
              <span>{{ email() }}</span>
            </div>
            <a routerLink="/settings" role="menuitem" (click)="open.set(false)">{{ 'menu.settings' | t }}</a>
            <button type="button" role="menuitem" (click)="logout()">{{ 'common.logout' | t }}</button>
          </div>
        }
      </div>
    </header>
  `,
  styles: `
    .app-header { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 8px;
      height: 52px; padding: 0 12px; background: #1565c0; color: #fff; }
    .brand { color: #fff; text-decoration: none; font-weight: bold; font-size: 16px; }
    .spacer { flex: 1; }
    .account { position: relative; }
    .account-btn { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 8px;
      background: rgba(255, 255, 255, 0.15); color: #fff; border: none; border-radius: 20px; cursor: pointer; }
    .account-btn img, .initial { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
    .initial { display: flex; align-items: center; justify-content: center; background: #fff; color: #1565c0;
      font-size: 14px; font-weight: bold; }
    .gear { font-size: 16px; }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 52; min-width: 220px;
      background: #fff; color: #222; border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .who { display: flex; flex-direction: column; gap: 2px; padding: 8px 16px 10px; border-bottom: 1px solid #eee; }
    .who span { font-size: 12px; color: #666; overflow-wrap: anywhere; }
    .menu a, .menu button { display: block; text-align: left; padding: 0 16px; min-height: 44px; line-height: 44px;
      background: none; border: none; color: #222; text-decoration: none; font-size: 14px; cursor: pointer; }
    .menu a:hover, .menu button:hover { background: #f5f5f5; }
  `,
})
export class AppHeader {
  private authService = inject(AuthService);
  private router = inject(Router);

  open = signal(false);
  name = computed(() => this.authService.profile()?.displayName || this.authService.user()?.email || '');
  email = computed(() => this.authService.user()?.email ?? '');
  photo = computed(() => this.authService.user()?.photoURL ?? null);
  initial = computed(() => this.name().slice(0, 1) || '?');

  async logout() {
    this.open.set(false);
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
}