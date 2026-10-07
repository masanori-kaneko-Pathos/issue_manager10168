import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { auth } from '../../core/firebase';
import { focusById } from '../../core/dom';
import { Invitation, Role } from '../../core/models';
import { ProjectContext } from '../../core/project-context';
import { ProjectService } from '../../core/project.service';
import { TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-project-members',
  imports: [FormsModule, TPipe],
  template: `
    <section>
      <h2>{{ 'project.members' | t }}</h2>
      <ul class="list">
        @for (m of ctx.members(); track m.uid) {
          <li><span class="name">{{ m.displayName }}</span>
            <span class="role">{{ 'roles.' + m.role | t }}</span></li>
        }
      </ul>
    </section>

    @if (ctx.role() === 'admin') {
      <section>
        <h2>{{ 'project.invite' | t }}</h2>
        <form class="invite" (ngSubmit)="invite()">
          <input id="invite-email" type="email" name="email" [(ngModel)]="inviteEmail" required autocomplete="off"
            [placeholder]="'project.inviteEmail' | t" />
          <div class="roles">
            @for (r of roles; track r) {
              <button type="button" [class.on]="inviteRole() === r" [attr.aria-pressed]="inviteRole() === r"
                (click)="inviteRole.set(r)">{{ 'roles.' + r | t }}</button>
            }
          </div>
          <button type="submit" class="primary" [disabled]="busy() || !inviteEmail.trim()">
            {{ 'project.inviteSubmit' | t }}</button>
        </form>
        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

        @if (invitations().length) {
          <h3>{{ 'project.pending' | t }}</h3>
          <ul class="list">
            @for (i of invitations(); track i.email) {
              <li><span class="name">{{ i.email }}</span>
                <span class="role">{{ 'roles.' + i.role | t }}</span>
                <button type="button" class="link" (click)="cancel(i)">{{ 'project.cancelInvite' | t }}</button></li>
            }
          </ul>
        }
      </section>
    }
  `,
  styles: `
    h2 { font-size: 16px; margin-top: 8px; } h3 { font-size: 14px; }
    section { margin-bottom: 24px; }
    input, button { min-height: 48px; font-size: 16px; }
    input { padding: 0 12px; }
    .invite { display: flex; flex-direction: column; gap: 8px; max-width: 480px; }
    .roles { display: flex; gap: 8px; }
    .roles button { flex: 1; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 8px; }
    .roles button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .primary { background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; }
    .primary:disabled { background: var(--disabled); }
    .link { background: none; border: none; color: var(--primary); }
    .list { list-style: none; padding: 0; }
    .list li { display: flex; gap: 8px; align-items: center; min-height: 48px; border-bottom: 1px solid var(--border); }
    .list .name { flex: 1; overflow-wrap: anywhere; }
    .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); }
    .error { color: var(--danger-text); }
  `,
})
export class ProjectMembers implements OnInit {
  protected ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private route = inject(ActivatedRoute);

  readonly roles: Role[] = ['member', 'viewer', 'admin'];
  invitations = signal<Invitation[]>([]);
  busy = signal(false);
  error = signal('');
  inviteEmail = '';
  inviteRole = signal<Role>('member');

  constructor() {
    // ヘッダーの「メンバーを招待」から来たら、招待欄に移る
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((f) => {
      if (f === 'invite') focusById('invite-email');
    });
  }

  async ngOnInit() {
    if (this.ctx.role() === 'admin') {
      this.invitations.set(await this.ps.listInvitations(this.ctx.pid()));
    }
  }

  async invite() {
    const email = this.inviteEmail.trim().toLowerCase();
    if (!email) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.invite(this.ctx.project()!, email, this.inviteRole(), auth.currentUser!);
      this.inviteEmail = '';
      this.invitations.set(await this.ps.listInvitations(this.ctx.pid()));
    } catch (e) {
      console.error(e);
      this.error.set('project.inviteError');
    } finally {
      this.busy.set(false);
    }
  }

  async cancel(i: Invitation) {
    await this.ps.cancelInvitation(this.ctx.pid(), i.email);
    this.invitations.update((list) => list.filter((x) => x.email !== i.email));
  }
}