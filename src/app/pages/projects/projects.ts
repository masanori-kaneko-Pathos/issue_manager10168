import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { focusById } from '../../core/dom';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth.service';
import { ProjectService } from '../../core/project.service';
import { Invitation, Issue, Level, ProjectWithRole } from '../../core/models';
import { IssueService } from '../../core/issue.service';
import { Clock } from '../../core/clock';
import { compareIssues, priorityOf } from '../../core/priority';
import { remainingOf, shortDue } from '../../core/time';
import { I18nService, TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-projects',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
   

    <main>
      @if (needsVerify()) {
        <div class="notice">
          <p>{{ 'verify.message' | t }}</p>
          <button type="button" class="link" (click)="resendVerification()">{{ 'verify.resend' | t }}</button>
          <button type="button" class="link" (click)="checkVerified()">{{ 'verify.done' | t }}</button>
          @if (info()) { <p>{{ info() | t }}</p> }
        </div>
      }

      @if (invitations().length) {
        <h2>{{ 'invitations.title' | t }}</h2>
        <ul class="list">
          @for (inv of invitations(); track inv.projectId) {
            <li class="invitation">
              <span class="name">{{ 'invitations.from' | t: {
                name: inv.invitedByName, project: inv.projectName, role: i18n.t('roles.' + inv.role) } }}</span>
              <button type="button" (click)="accept(inv)" [disabled]="busy()">{{ 'invitations.accept' | t }}</button>
              <button type="button" class="link" (click)="decline(inv)" [disabled]="busy()">{{ 'invitations.decline' | t }}</button>
            </li>
          }
        </ul>
      }

            <section class="mine">
        <div class="mine-head">
          <h2>{{ 'mine.title' | t }}</h2>
          <label class="check">
            <input type="checkbox" [checked]="showDone()" (change)="showDone.set(!showDone())" />
            {{ 'mine.showDone' | t }}
          </label>
        </div>
        <ul class="list">
          @for (i of visibleMine(); track i.id) {
            <li class="mine-item">
              <span class="prio" [attr.data-p]="prio(i)"></span>
              <a class="name" [routerLink]="['/p', i.projectId, 'i', i.id]">#{{ i.number }} {{ i.title }}</a>
              <span class="small">{{ projectName(i.projectId) }}</span>
              @if (isActive(i) && isOverdue(i)) {
                <span class="small overdue" [title]="remaining(i)">{{ 'due.overdue' | t }} {{ dueLabel(i) }}</span>
              } @else if (isActive(i)) {
                <span class="small">{{ dueLabel(i) }}・{{ remaining(i) }}</span>
              } @else {
                <span class="small">{{ 'status.' + i.status | t }}</span>
              }
            </li>
          } @empty {
            <li class="empty">{{ 'mine.empty' | t }}</li>
          }
        </ul>
      </section>

      <h2>{{ 'projects.title' | t }}</h2>

      <form class="create" (ngSubmit)="create()">
        <input id="new-project" name="name" [(ngModel)]="newName" maxlength="100" required
          [placeholder]="'projects.namePlaceholder' | t" />
        <button type="submit" [disabled]="busy() || !newName.trim()">{{ 'projects.create' | t }}</button>
      </form>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <ul class="list">
          @for (p of projects(); track p.id) {
            <li [class.archived]="p.archived">
              <a class="name" [routerLink]="['/p', p.id]">{{ p.name }}</a>
              <span class="role">{{ 'roles.' + p.role | t }}</span>
              @if (p.archived) { <span class="role">{{ 'projects.archived' | t }}</span> }
            </li>
          } @empty {
            <li class="empty">{{ 'projects.empty' | t }}</li>
          }
        </ul>
      }
    </main>
  `,
  styles: `
    .bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
    .bar h1 { font-size: 18px; margin: 0; flex: 1; }
    main { max-width: 640px; margin: 0 auto; padding: 16px; }
    .create { display: flex; gap: 8px; }
    .create input { flex: 1; min-width: 0; }
    input, button { min-height: 48px; font-size: 16px; }
    input { padding: 0 12px; }
    .link { background: none; border: none; color: var(--primary); }
    .list { list-style: none; padding: 0; }
    .list li { display: flex; gap: 8px; align-items: center; min-height: 56px; padding: 0 12px; border-bottom: 1px solid var(--border); }
    .list .name { flex: 1; }
    .list .role { font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--chip-bg); }
    .archived { color: var(--text-subtle); }
    .empty { color: var(--text-muted); }
    .error { color: var(--danger-text); }
    .notice { background: var(--warning-bg); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .notice p { margin: 0 0 8px; }
    h2 { font-size: 16px; }
    .invitation { flex-wrap: wrap; padding: 8px 12px !important; }
    .invitation .name { flex-basis: 100%; }
    .mine { margin-bottom: 24px; }
    .mine-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .check { display: flex; align-items: center; gap: 6px; font-size: 13px; min-height: 40px; }
    .mine-item { flex-wrap: wrap; }
    .mine-item .name { flex: 1; min-width: 50%; overflow-wrap: anywhere; }
    .prio { width: 10px; height: 10px; border-radius: 50%; background: var(--disabled); flex: none; }
    .prio[data-p='high'] { background: var(--danger); }
    .prio[data-p='mid'] { background: var(--warning); }
    .prio[data-p='low'] { background: var(--success); }
    .small { font-size: 12px; color: var(--text-muted); }
    .small.overdue { color: var(--danger); font-weight: bold; }
  `,
})
export class Projects implements OnInit {
  private authService = inject(AuthService);
  private projectService = inject(ProjectService);
  private issueService = inject(IssueService);
  private clock = inject(Clock);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  private router = inject(Router);
  protected i18n = inject(I18nService);
  private route = inject(ActivatedRoute);

  constructor() {
    // ヘッダーの「プロジェクトを作成」から来たら、作成欄に移る
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      if (p.get('create')) focusById('new-project');
    });
  }

  projects = signal<ProjectWithRole[]>([]);
  invitations = signal<Invitation[]>([]);
  myIssues = signal<(Issue & { projectId: string })[]>([]);
  showDone = signal(false);
  /** 初期は自分の手が必要なもの（未着手・対応中・保留）。切り替えで解決済み・クローズも表示 */
  visibleMine = computed(() => {
    const now = this.clock.now();
    return this.myIssues()
      .filter((i) => this.showDone() || this.isActive(i))
      .sort((a, b) => compareIssues(a, b, now));
  });
  needsVerify = signal(false);
  info = signal('');
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  newName = '';

  ngOnInit() {
    const u = auth.currentUser!;
    this.needsVerify.set(!!u.email && !u.emailVerified);
    this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      this.projects.set(await this.projectService.listMine(auth.currentUser!.uid));
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
    // 招待と自分の課題は、失敗しても一覧の表示を止めない
    await this.loadInvitations();
    await this.loadMyIssues();
  }

  private async loadInvitations() {
    const email = auth.currentUser!.email;
    if (!email || this.needsVerify()) return;
    try {
      this.invitations.set(await this.projectService.listMyInvitations(email));
    } catch (e) {
      console.error('招待の読み込みに失敗', e);
    }
  }

  private async loadMyIssues() {
    try {
      this.myIssues.set(await this.issueService.listMine(auth.currentUser!.uid));
    } catch (e) {
      console.error('自分の課題の読み込みに失敗', e);
    }
  }

  async create() {
    const name = this.newName.trim();
    if (!name) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.projectService.create(name, auth.currentUser!);
      this.newName = '';
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async accept(inv: Invitation) {
    this.busy.set(true);
    try {
      await this.projectService.acceptInvitation(inv, auth.currentUser!);
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async decline(inv: Invitation) {
    await this.projectService.declineInvitation(inv);
    this.invitations.update((list) => list.filter((x) => x.projectId !== inv.projectId));
  }
  async resendVerification() {
    await sendEmailVerification(auth.currentUser!);
    this.info.set('verify.sent');
  }

  /** 確認メールのリンクを押したあと、ログイン情報を取り直して反映する */
  async checkVerified() {
    const u = auth.currentUser!;
    await u.reload();
    await u.getIdToken(true);
    this.needsVerify.set(!u.emailVerified);
    await this.load();
  }

  projectName(pid: string) {
    return this.projects().find((p) => p.id === pid)?.name ?? '';
  }
  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }

  async logout() {
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}