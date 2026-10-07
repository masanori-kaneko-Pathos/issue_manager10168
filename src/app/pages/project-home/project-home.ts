import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { ProjectService } from '../../core/project.service';
import { Invitation, Issue, Member, Project, Role } from '../../core/models';
import { IssueService } from '../../core/issue.service';
import { I18nService, TPipe } from '../../i18n/i18n';
import { IssueList } from './issue-list/issue-list';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { focusById } from '../../core/dom';

@Component({
  selector: 'app-project-home',
  imports: [FormsModule, RouterLink, TPipe, IssueList],
  template: `
    <header class="bar"><a routerLink="/" class="link">{{ 'project.back' | t }}</a></header>
    <main>
      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else if (!project()) {
        <p>{{ 'project.notFound' | t }}</p>
      } @else {
        <h1>{{ project()!.name }} <span class="role">{{ 'roles.' + role() | t }}</span></h1>
        <app-issue-list [pid]="pid" [members]="members()" [canCreate]="canCreate()"
          [isViewer]="role() === 'viewer'" />

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
              <input id="invite-email" type="email" name="email" [(ngModel)]="inviteEmail" required autocomplete="off"
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
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 640px; margin: 0 auto; padding: 16px; }
    h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; } h3 { font-size: 14px; }
    input, button { min-height: 48px; font-size: 16px; }
    input { padding: 0 12px; }
    .invite { display: flex; flex-direction: column; gap: 8px; }
    .roles { display: flex; gap: 8px; }
    .roles button { flex: 1; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 8px; }
    .roles button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .link { background: none; border: none; color: var(--primary); }
    .list { list-style: none; padding: 0; }
    .list li { display: flex; gap: 8px; align-items: center; min-height: 48px; border-bottom: 1px solid var(--border); }
    .list .name { flex: 1; overflow-wrap: anywhere; }
    .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); font-weight: normal; }
    .error { color: var(--danger-text); }
        .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .primary { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px;
      background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; text-decoration: none; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .help { font-size: 12px; color: var(--text-muted); }
    .issue { flex-wrap: wrap; }
    .prio { width: 10px; height: 10px; border-radius: 50%; background: var(--disabled); flex: none; }
    .prio[data-p='high'] { background: var(--danger); }
    .prio[data-p='mid'] { background: var(--warning); }
    .prio[data-p='low'] { background: var(--success); }
    .num { color: var(--text-muted); font-size: 13px; }
    .meta, .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .empty { color: var(--text-muted); }
  `,
})
export class ProjectHome implements OnInit {
  private route = inject(ActivatedRoute);
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private i18n = inject(I18nService);

  readonly roles: Role[] = ['member', 'viewer', 'admin'];
  readonly pid = this.route.snapshot.paramMap.get('pid')!;
  constructor() {
    // ヘッダーの「メンバーを招待」から来たら、招待欄に移る（読み込みが終わるまで待つ）
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((f) => {
      if (f === 'invite') focusById('invite-email');
    });
  }

  project = signal<Project | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  invitations = signal<Invitation[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  inviteEmail = '';
  inviteRole = signal<Role>('member');
  issues = signal<Issue[]>([]);
  canCreate = computed(() =>
    (this.role() === 'admin' || this.role() === 'member') && !this.project()?.archived);

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