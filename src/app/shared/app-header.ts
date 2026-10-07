import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { auth } from '../core/firebase';
import { Role } from '../core/models';
import { ProjectService } from '../core/project.service';
import { TPipe } from '../i18n/i18n';
import { HelpTip } from './help-tip';

@Component({
  selector: 'app-header',
  imports: [RouterLink, TPipe, HelpTip],
  host: { '(document:keydown.escape)': 'open.set(false); addOpen.set(false)' },
  template: `
    <header class="app-header">
      <a routerLink="/" class="brand">{{ 'app.title' | t }}</a>
      <span class="spacer"></span>
      <div class="add">
        <button type="button" class="add-btn" [attr.aria-expanded]="addOpen()"
          [attr.aria-label]="'menu.add' | t" [title]="'menu.add' | t" (click)="toggleAdd()">＋</button>
        @if (addOpen()) {
          <div class="backdrop" (click)="addOpen.set(false)"></div>
          <div class="menu" role="menu">
            <button type="button" role="menuitem" class="primary-item" (click)="newIssue()">
              {{ 'menu.newIssue' | t }}</button>
            <button type="button" role="menuitem" (click)="newProject()">{{ 'menu.newProject' | t }}</button>
            <div class="item-row">
              <button type="button" role="menuitem" [disabled]="!canInvite()" (click)="invite()">
                {{ 'menu.invite' | t }}</button>
              @if (!canInvite()) {
                <app-help-tip kind="denied" align="right" [keys]="[inviteDenied()]" />
              }
            </div>
          </div>
        }
      </div>
      <div class="account">
        <button type="button" class="account-btn" [attr.aria-expanded]="open()"
          [attr.aria-label]="'menu.account' | t" (click)="toggleAccount()">
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
      height: 52px; padding: 0 12px; background: var(--primary); color: var(--on-primary); }
    .brand { color: var(--on-primary); text-decoration: none; font-weight: bold; font-size: 16px; }
    .spacer { flex: 1; }
    .add-btn { width: 36px; height: 36px; border-radius: 50%; border: none; background: var(--on-primary);
      color: var(--primary); font-size: 22px; font-weight: bold; line-height: 1; cursor: pointer; }
    .add { position: relative; }
    .primary-item { font-weight: bold; color: var(--primary) !important; }
    .item-row { display: flex; align-items: center; padding-right: 12px; }
    .item-row button { flex: 1; }
    .menu button:disabled { color: var(--text-disabled); cursor: default; }
    .menu button:disabled:hover { background: none; }
    .account { position: relative; }
    .account-btn { display: flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 8px;
      background: rgba(255, 255, 255, 0.15); color: var(--on-primary); border: none; border-radius: 20px; cursor: pointer; }
    .account-btn img, .initial { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
    .initial { display: flex; align-items: center; justify-content: center; background: var(--surface); color: var(--primary);
      font-size: 14px; font-weight: bold; }
    .gear { font-size: 16px; }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 52; min-width: 220px;
      background: var(--surface); color: var(--text); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .who { display: flex; flex-direction: column; gap: 2px; padding: 8px 16px 10px; border-bottom: 1px solid var(--border); }
    .who span { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .menu a, .menu button { display: block; text-align: left; padding: 0 16px; min-height: 44px; line-height: 44px;
      background: none; border: none; color: var(--text); text-decoration: none; font-size: 14px; cursor: pointer; }
    .menu a:hover, .menu button:hover { background: var(--surface-alt); }
  `,
})
export class AppHeader {
  private authService = inject(AuthService);
  private router = inject(Router);
  private projectService = inject(ProjectService);

  addOpen = signal(false);
  /** メニューを開いたときにいたプロジェクトと、そこでの自分のロール */
  ctx = signal<{ pid: string | null; role: Role | null }>({ pid: null, role: null });
  canInvite = computed(() => !!this.ctx().pid && this.ctx().role === 'admin');
  inviteDenied = computed(() => (this.ctx().pid ? 'menu.inviteNeedAdmin' : 'menu.inviteNeedProject'));

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
  private currentPid(): string | null {
    return this.router.url.match(/^\/p\/([^/?#]+)/)?.[1] ?? null;
  }

  toggleAccount() {
    this.addOpen.set(false);
    this.open.set(!this.open());
  }

  /** 開くときに、今いるプロジェクトでの自分のロールを確かめる */
  async toggleAdd() {
    if (this.addOpen()) {
      this.addOpen.set(false);
      return;
    }
    this.open.set(false);
    const pid = this.currentPid();
    let role: Role | null = null;
    if (pid) {
      try {
        role = await this.projectService.myRole(pid, auth.currentUser!.uid);
      } catch {
        role = null;
      }
    }
    this.ctx.set({ pid, role });
    this.addOpen.set(true);
  }

  /** プロジェクトの中にいるときは、そのプロジェクトを選んだ状態で開く */
  newIssue() {
    this.addOpen.set(false);
    const pid = this.currentPid();
    this.router.navigate(['/new'], { queryParams: pid ? { p: pid } : {} });
  }

  newProject() {
    this.addOpen.set(false);
    // 毎回違う値にして、一覧にいるときに押しても入力欄に移るようにする
    this.router.navigate(['/'], { queryParams: { create: Date.now() } });
  }

  invite() {
    const pid = this.ctx().pid;
    this.addOpen.set(false);
    if (pid) this.router.navigate(['/p', pid, 'members'], { fragment: 'invite' });
  }
}