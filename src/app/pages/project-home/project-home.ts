import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { ProjectService } from '../../core/project.service';
import { Invitation, Member, Project, Role } from '../../core/models';
import { TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-project-home',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'project.back' | t }}</a></header>
    <main>
      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!project()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        <h1>{{ project()!.name }} <span class="role">{{ 'roles.' + role() | t }}</span></h1>

        <section>
          <h2>{{ 'project.members' | t }}</h2>
          <ul class="list">
            @for (m of members(); track m.uid) {
              <li><span class="name">{{ m.displayName }}</span>
                <span class="role">{{ 'roles.' + m.role | t }}</span></li>
            }
          </ul>
        </section>

        @if (role() === 'admin') {
          <section>
            <h2>{{ 'project.invite' | t }}</h2>
            <form class="invite" (ngSubmit)="invite()">
              <input type="email" name="email" [(ngModel)]="inviteEmail" required autocomplete="off"
                [placeholder]="'project.inviteEmail' | t" />
              <div class="roles">
                @for (r of roles; track r) {
                  <button type="button" [class.on]="inviteRole() === r"
                    [attr.aria-pressed]="inviteRole() === r" (click)="inviteRole.set(r)">
                    {{ 'roles.' + r | t }}
                  </button>
                }
              </div>
              <button type="submit" [disabled]="busy() || !inviteEmail.trim()">
                {{ 'project.inviteSubmit' | t }}
              </button>
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
      }
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid #ddd; }
    main { max-width: 640px; margin: 0 auto; padding: 16px; }
    h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; } h3 { font-size: 14px; }
    input, button { min-height: 48px; font-size: 16px; }
    input { padding: 0 12px; }
    .invite { display: flex; flex-direction: column; gap: 8px; }
    .roles { display: flex; gap: 8px; }
    .roles button { flex: 1; border: 1px solid #ccc; background: #fff; border-radius: 8px; }
    .roles button.on { background: #1565c0; color: #fff; border-color: #1565c0; }
    .link { background: none; border: none; color: #1565c0; }
    .list { list-style: none; padding: 0; }
    .list li { display: flex; gap: 8px; align-items: center; min-height: 48px; border-bottom: 1px solid #eee; }
    .list .name { flex: 1; overflow-wrap: anywhere; }
    .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: #eef; font-weight: normal; }
    .error { color: #c62828; }
  `,
})
export class ProjectHome implements OnInit {
  private route = inject(ActivatedRoute);
  private ps = inject(ProjectService);

  readonly roles: Role[] = ['member', 'viewer', 'admin'];
  readonly pid = this.route.snapshot.paramMap.get('pid')!;

  project = signal<Project | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  invitations = signal<Invitation[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  inviteEmail = '';
  inviteRole = signal<Role>('member');

  async ngOnInit() {
    try {
      // メンバーでなければ、ここでルールに止められて例外になる
      this.role.set(await this.ps.myRole(this.pid, auth.currentUser!.uid));
      this.project.set(await this.ps.get(this.pid));
      this.members.set(await this.ps.listMembers(this.pid));
      if (this.role() === 'admin') this.invitations.set(await this.ps.listInvitations(this.pid));
    } catch (e) {
      console.error(e);
      this.project.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async invite() {
    const email = this.inviteEmail.trim().toLowerCase();
    if (!email) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.invite(this.project()!, email, this.inviteRole(), auth.currentUser!);
      this.inviteEmail = '';
      this.invitations.set(await this.ps.listInvitations(this.pid));
    } catch (e) {
      console.error(e);
      this.error.set('project.inviteError');
    } finally {
      this.busy.set(false);
    }
  }

  async cancel(i: Invitation) {
    await this.ps.cancelInvitation(this.pid, i.email);
    this.invitations.update((list) => list.filter((x) => x.email !== i.email));
  }
}