import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { IssueStatus, Member, OPEN_STATUSES } from '../../core/models';
import { MemberSelect } from '../../shared/member-select';
import { HelpTip } from '../../shared/help-tip';
import { I18nService, TPipe } from '../../i18n/i18n';
import { PwField } from '../../shared/pw-field';

/** purge＝一緒に削除、leave＝抜ける、blocked＝ほかに管理者がいないので止める（関数 imDeleteAccount と同じ決まり） */
type Kind = 'purge' | 'leave' | 'blocked';
interface Row {
  pid: string;
  name: string;
  kind: Kind;
  open: number;          // 自分が担当の、未完了の課題の数
  candidates: Member[];  // 引き継げる人（自分以外の管理者・メンバー）
  archived: boolean;
}

@Component({
  selector: 'app-delete-account',
  imports: [FormsModule, RouterLink, TPipe, MemberSelect, HelpTip, PwField],
  template: `
    <main>
      <h1>{{ 'deleteAccount.title' | t }}</h1>
      @if (done()) {
        <section role="status">
          <p>{{ 'deleteAccount.done' | t }}</p>
          <a routerLink="/login" class="link">{{ 'deleteAccount.toLogin' | t }}</a>
        </section>
      } @else if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <p class="lead">{{ 'deleteAccount.lead' | t }}</p>

        @if (blocked().length) {
          <section class="blocked">
            <h2>{{ 'deleteAccount.blockedTitle' | t }}</h2>
            <p class="help">{{ 'deleteAccount.blockedHelp' | t }}</p>
            <ul>
              @for (r of blocked(); track r.pid) {
                <li><a [routerLink]="['/p', r.pid, 'members']">{{ r.name }}</a>
                  @if (r.archived) { <span class="help">{{ 'deleteAccount.archivedNote' | t }}</span> }</li>
              }
            </ul>
          </section>
        }

        @if (leave().length) {
          <section>
            <h2>{{ 'deleteAccount.leaveTitle' | t }}</h2>
            <p class="help">{{ 'deleteAccount.leaveHelp' | t }}</p>
            @for (r of leave(); track r.pid) {
              <div class="proj">
                <strong>{{ r.name }}</strong>
                @if (r.open) {
                  <label class="field">{{ 'deleteAccount.handover' | t: { n: '' + r.open } }}
                    <app-member-select [selectId]="'h-' + r.pid" [members]="r.candidates"
                      [value]="handovers()[r.pid] ?? ''" (picked)="pick(r.pid, $event)" />
                  </label>
                } @else {
                  <span class="help">{{ 'deleteAccount.noOpen' | t }}</span>
                }
              </div>
            }
          </section>
        }

        @if (purge().length) {
          <section>
            <h2>{{ 'deleteAccount.purgeTitle' | t }}</h2>
            <p class="help">{{ 'deleteAccount.purgeHelp' | t }}</p>
            <ul>
              @for (r of purge(); track r.pid) { <li>{{ r.name }}</li> }
            </ul>
          </section>
        }

        <section>
          <h2>{{ 'deleteAccount.confirmTitle' | t }}</h2>
          <p class="help">{{ 'deleteAccount.keeps' | t }}</p>
          @if (isPasswordUser) {
            <label class="field">{{ 'deleteAccount.password' | t }}
              <app-pw-field><input type="password" name="current-password" autocomplete="current-password" [(ngModel)]="password" /></app-pw-field>
            </label>
          } @else {
            <p class="help">{{ 'deleteAccount.googleHelp' | t }}</p>
          }
          @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
          <div class="row">
            @if (blocked().length) { <app-help-tip kind="denied" [keys]="['deleteAccount.blockedHelp']" /> }
            <button type="button" class="danger" [disabled]="!canDelete()" (click)="remove()">
              {{ (busy() ? 'deleteAccount.running' : 'deleteAccount.confirm') | t }}</button>
          </div>
        </section>
      }
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 560px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; }
    .lead { padding: 10px 12px; border-radius: 8px; background: var(--danger-bg); color: var(--danger-text); }
    section { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 10px; }
    section.blocked { border-color: var(--warning-border); background: var(--warning-bg); }
    h2 { font-size: 16px; margin: 0; }
    ul { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 4px; }
    .proj { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid var(--border); }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    input { min-height: 44px; font-size: 16px; padding: 0 12px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 0; }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); }
    .danger { min-height: 44px; padding: 0 20px; border: none; border-radius: 8px; font-size: 14px;
      background: var(--danger); color: var(--on-primary); cursor: pointer; }
    .danger:disabled { background: var(--disabled); cursor: default; }
  `,
})
export class DeleteAccount implements OnInit {
  private authService = inject(AuthService);
  private ps = inject(ProjectService);
  private i18n = inject(I18nService);

  readonly isPasswordUser = this.authService.isPasswordUser();
  rows = signal<Row[]>([]);
  /** プロジェクトごとの、引き継ぐ人（pid → uid） */
  handovers = signal<Record<string, string>>({});
  password = '';
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  done = signal(false);

  blocked = computed(() => this.rows().filter((r) => r.kind === 'blocked'));
  leave = computed(() => this.rows().filter((r) => r.kind === 'leave'));
  purge = computed(() => this.rows().filter((r) => r.kind === 'purge'));
  /** 押せるか：止める行がなく、引き継ぐ人が全部決まっている（パスワードの人は入力済み） */
  canDelete = computed(() => !this.busy() && !this.blocked().length
    && this.leave().every((r) => !r.open || !!this.handovers()[r.pid]));

  async ngOnInit() {
    try {
      const uid = auth.currentUser!.uid;
      const projects = await this.ps.listMyProjects(uid);
      const rows = await Promise.all(projects.map(async (p): Promise<Row> => {
        const [members, assigned] = await Promise.all([
          this.ps.listMembers(p.id),
          getDocs(query(collection(db, 'projects', p.id, 'issues'), where('assigneeId', '==', uid))),
        ]);
        const others = members.filter((m) => m.uid !== uid);
        const kind: Kind = !others.length ? 'purge'
          : p.role === 'admin' && !others.some((m) => m.role === 'admin') ? 'blocked' : 'leave';
        return {
          pid: p.id, name: p.name, kind, archived: p.archived,
          open: assigned.docs.filter((d) => OPEN_STATUSES.includes(d.data()['status'] as IssueStatus)).length,
          candidates: others.filter((m) => m.role !== 'viewer'),
        };
      }));
      this.rows.set(rows);
      // 引き継ぐ人の初期値：ほかの管理者（いなければ、名前順の最初の人）
      const first: Record<string, string> = {};
      for (const r of rows) {
        if (r.kind !== 'leave' || !r.open) continue;
        first[r.pid] = (r.candidates.find((m) => m.role === 'admin') ?? r.candidates[0])?.uid ?? '';
      }
      this.handovers.set(first);
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  pick(pid: string, uid: string) {
    this.handovers.update((m) => ({ ...m, [pid]: uid }));
  }

  async remove() {
    if (this.isPasswordUser && !this.password) {
      this.error.set('deleteAccount.password');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.authService.reauthenticate(this.password);
      await this.authService.deleteAccount(this.handovers(), this.i18n.t('deleteAccount.reason'));
      this.done.set(true);
    } catch (e) {
      console.error(e);
      const code = (e as { code?: string }).code ?? '';
      this.error.set(
        code.includes('invalid-credential') || code.includes('wrong-password') ? 'settings.pwWrong'
        // Google の窓を自分で閉じた：何も出さない
        : code.includes('popup-closed') || code.includes('cancelled-popup') ? ''
        : code.includes('failed-precondition') ? 'deleteAccount.changed'
        : 'common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}