import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { auth } from '../../core/firebase';
import { focusById } from '../../core/dom';
import { Invitation, Member, Role } from '../../core/models';
import { AuthService } from '../../core/auth/auth.service';
import { HelpTip } from '../../shared/help-tip';
import { HandoverDialog, HandoverMode } from './handover-dialog';
import { ProjectContext } from './project-context';
import { ProjectService } from '../../core/project/project.service';
import { I18nService, TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-tab-members',
  imports: [FormsModule, TPipe, HelpTip, HandoverDialog],
  host: { '(document:keydown.escape)': 'menuFor.set(null)' },
  template: `
    <section>
      <h2>{{ 'project.members' | t }}</h2>
      <ul class="list">
        @for (m of ctx.members(); track m.uid) {
          @let n = assignedCount()[m.uid] ?? 0;
          <li class="member">
            <span class="name">{{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</span>
            @if (manageable(m)) {
              <div class="role-menu">
                <button type="button" class="role-btn" aria-haspopup="menu" [attr.aria-expanded]="menuFor() === m.uid"
                  [attr.aria-label]="'members.changeRole' | t: { name: m.displayName }" [disabled]="busy()"
                  (click)="menuFor.set(menuFor() === m.uid ? null : m.uid)">
                  {{ 'roles.' + m.role | t }} <span aria-hidden="true">▾</span></button>
                @if (menuFor() === m.uid) {
                  <div class="backdrop" (click)="menuFor.set(null)"></div>
                  <div class="menu" role="menu">
                    @for (r of roleOrder; track r) {
                      <button type="button" role="menuitemradio" [attr.aria-checked]="m.role === r" (click)="pickRole(m, r)">
                        <span class="check" aria-hidden="true">{{ m.role === r ? '✓' : '' }}</span>
                        <span class="opt">
                          <span class="opt-name">{{ 'roles.' + r | t }}</span>
                          <span class="opt-help">{{ 'roleHelp.' + r | t }}</span>
                        </span>
                      </button>
                    }
                  </div>
                }
              </div>
              <span class="count">{{ 'members.count' | t: { n: '' + n } }}</span>
              <button type="button" class="link" [disabled]="!n" (click)="openDialog('handover', m)">
                {{ 'members.handover' | t }}</button>
              <button type="button" class="link danger" (click)="openDialog('remove', m)">{{ 'members.remove' | t }}</button>
            } @else {
              <span class="role">{{ 'roles.' + m.role | t }}</span>
              @if (ctx.role() === 'admin') {
                <span class="count">{{ 'members.count' | t: { n: '' + n } }}</span>
                @if (m.uid === myUid) { <app-help-tip kind="denied" align="right" [keys]="['members.selfNote']" /> }
              }
            }
          </li>
        }
      </ul>
      @if (roleError()) { <p class="error" role="alert">{{ roleError() | t }}</p> }
    </section>

    @if (dialog(); as d) {
      <app-handover-dialog [mode]="d.mode" [target]="d.member" [role]="d.role"
        (done)="dialog.set(null)" (cancel)="dialog.set(null)" />
    }

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
        .member { flex-wrap: wrap; padding: 6px 0; }
    .role-menu { position: relative; }
    .role-btn { min-height: 36px; padding: 0 10px; font-size: 13px; border: 1px solid var(--border-strong);
      border-radius: 8px; background: var(--surface); cursor: pointer; white-space: nowrap; }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; left: 0; top: calc(100% + 4px); z-index: 52; width: min(300px, 80vw);
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu button { display: flex; align-items: flex-start; gap: 8px; width: 100%; min-height: 48px; padding: 8px 12px;
      background: none; border: none; text-align: left; cursor: pointer; font-size: 14px; }
    .menu button:hover { background: var(--surface-alt); }
    .check { width: 16px; flex: none; color: var(--primary); font-weight: bold; }
    .opt { display: flex; flex-direction: column; gap: 2px; }
    .opt-name { font-weight: bold; }
    .opt-help { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .count { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
  `,
})
export class ProjectMembers {
  protected ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private route = inject(ActivatedRoute);

  /** 招待欄の役割（よく選ぶものを先に） */
  readonly roles: Role[] = ['member', 'viewer', 'admin'];
  /** 役割のメニュー（権限の強い順） */
  readonly roleOrder: Role[] = ['admin', 'member', 'viewer'];
  /** 役割のメニューを開いているメンバー */
  menuFor = signal<string | null>(null);
  private i18n = inject(I18nService);
  invitations = signal<Invitation[]>([]);
  busy = signal(false);
  error = signal('');
  inviteEmail = '';
  inviteRole = signal<Role>('member');
  private authService = inject(AuthService);
  readonly myUid = auth.currentUser!.uid;
  roleError = signal('');
  /** 開いている引き継ぎのモーダル */
  dialog = signal<{ mode: HandoverMode; member: Member; role: Role | null } | null>(null);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** メンバーごとの担当中の件数（置き場の見張りから数える） */
  assignedCount = computed(() => {
    const map: Record<string, number> = {};
    for (const i of this.ctx.openIssues()) map[i.assigneeId] = (map[i.assigneeId] ?? 0) + 1;
    return map;
  });

  /** 管理者が、自分以外を操作できる（自分の役割は変えられない＝最後の管理者が必ず残る） */
  manageable(m: Member) {
    return this.ctx.role() === 'admin' && m.uid !== this.myUid && !this.ctx.project()?.archived;
  }

  openDialog(mode: HandoverMode, m: Member) {
    this.dialog.set({ mode, member: m, role: null });
  }

  /** 閲覧者に変えるときは、担当があれば先に引き継ぐ。それ以外は、すぐ変える */
  async pickRole(m: Member, r: Role) {
    this.menuFor.set(null);
    if (m.role === r) return;
    // 管理者は、メンバーを外したり、ほかの管理者を降格したりできる強い権限なので、渡す前に確かめる
    if (r === 'admin' && !confirm(this.i18n.t('members.promoteConfirm', { name: m.displayName }))) return;
    if (r === 'viewer' && (this.assignedCount()[m.uid] ?? 0) > 0) {
      this.dialog.set({ mode: 'role', member: m, role: r });
      return;
    }
    this.busy.set(true);
    this.roleError.set('');
    try {
      await this.ps.changeMember(this.ctx.pid(), m, [], null, '', { kind: 'role', role: r }, this.myUid, this.tz());
    } catch (e) {
      console.error(e);
      this.roleError.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  constructor() {
    // ヘッダーの「メンバーを招待」から来たら、招待欄に移る
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((f) => {
      if (f === 'invite') focusById('invite-email');
    });
  }

  /** 管理者になった時点で、招待中の一覧を読む（開いている間に役割が上がっても読めるように） */
  private loadInvitationsWhenAdmin = effect(() => {
    if (this.ctx.role() !== 'admin') return;
    untracked(async () => {
      try {
        this.invitations.set(await this.ps.listInvitations(this.ctx.pid()));
      } catch (e) {
        console.error(e);
      }
    });
  });

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