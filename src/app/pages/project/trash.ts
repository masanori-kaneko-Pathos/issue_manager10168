import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Unsubscribe } from 'firebase/firestore';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ConflictError, IssueService } from '../../core/issue/issue.service';
import { Issue } from '../../core/models';
import { formatDateTime } from '../../core/time/time';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 削除フォルダ。プロジェクトの「⋮」メニューから開く（タブにはしない） */
@Component({
  selector: 'app-trash',
  imports: [RouterLink, TPipe],
  template: `
    <section>
      <div class="head">
        <h2>{{ 'trash.title' | t }}</h2>
        <a class="link" [routerLink]="['/p', ctx.pid(), 'list']">{{ 'trash.back' | t }}</a>
      </div>
      <p class="help">{{ 'trash.help' | t }}</p>
      @if (ctx.role() !== 'admin') { <p class="help">{{ 'trash.rolesHelp' | t }}</p> }

      @if (restored(); as n) {
        <p class="ok" role="status">{{ 'delete.undone' | t: { n: '' + n } }}</p>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <ul class="list">
          @for (i of issues(); track i.id) {
            <li>
              <div class="main">
                <a class="name" [routerLink]="['/p', ctx.pid(), 'i', i.id]">
                  <span class="num">#{{ i.number }}</span> {{ i.title }}</a>
                <p class="meta">
                  {{ 'delete.by' | t: { name: memberName(i.deletedBy ?? ''), when: when(i) } }}
                  ・{{ 'trash.from' | t: { status: i18n.t('status.' + (i.deletedFrom ?? 'open')) } }}
                </p>
                @if (i.deletedReason) { <p class="reason">{{ i.deletedReason }}</p> }
              </div>
              <div class="actions">
                @if (canRestore(i)) {
                  <button type="button" class="restore" [disabled]="busyId() === i.id" (click)="restore(i)">
                    {{ 'delete.restore' | t }}</button>
                }
                @if (canPurge()) {
                  <button type="button" class="purge" [disabled]="busyId() === i.id" (click)="purge(i)">
                    {{ 'trash.purge' | t }}</button>
                }
              </div>
            </li>
          } @empty {
            <li class="empty">{{ 'trash.empty' | t }}</li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 16px; }
    .link { color: var(--primary); text-decoration: none; font-size: 14px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    .ok { color: var(--success-text); font-size: 13px; }
    .error { color: var(--danger-text); }
    .list { list-style: none; padding: 0; margin: 12px 0 0; }
    .list li { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 8px;
      border-bottom: 1px solid var(--border); }
    .main { flex: 1; min-width: 60%; }
    .name { color: var(--text); overflow-wrap: anywhere; }
    .num { color: var(--text-muted); font-size: 13px; }
    .meta { margin: 4px 0 0; font-size: 12px; color: var(--text-muted); }
    .reason { margin: 4px 0 0; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; }
    .actions button { min-height: 40px; padding: 0 14px; border-radius: 8px; font-size: 13px; cursor: pointer;
      background: var(--surface); }
    .restore { border: 1px solid var(--primary); color: var(--primary); }
    .purge { border: 1px solid var(--danger); color: var(--danger-text); }
    .actions button:disabled { border-color: var(--border-strong); color: var(--text-disabled); }
    .empty { color: var(--text-muted); }
  `,
})
export class Trash implements OnInit {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;
  private stop: Unsubscribe | null = null;

  issues = signal<Issue[]>([]);
  loading = signal(true);
  /** 復元・完全削除の最中の課題（二度押しを防ぐ） */
  busyId = signal<string | null>(null);
  error = signal('');
  /** 直前に復元した課題の番号（一覧から消えるので、何が起きたかを知らせる） */
  restored = signal<number | null>(null);

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  /** 完全削除は管理者だけ（アーカイブ中は不可） */
  canPurge = computed(() => this.ctx.role() === 'admin' && !this.ctx.project()?.archived);

  constructor() {
    // 削除フォルダを離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  ngOnInit() {
    this.stop = this.issueService.watchDeleted(
      this.ctx.pid(),
      (list) => {
        this.issues.set(list);
        this.loading.set(false);
      },
      (e) => {
        console.error(e);
        this.loading.set(false);
        this.error.set('common.loadError');
      },
    );
  }

  /** 復元は、管理者と、課題を登録した本人（メンバー）。アーカイブ中は不可 */
  canRestore(i: Issue) {
    if (this.ctx.project()?.archived) return false;
    const r = this.ctx.role();
    return r === 'admin' || (r === 'member' && i.reporterId === this.myUid);
  }

  async restore(i: Issue) {
    this.busyId.set(i.id);
    this.error.set('');
    try {
      await this.issueService.restoreIssue(this.ctx.pid(), i.id, this.myUid, this.tz(), this.adminsToNotify());
      this.restored.set(i.number);
    } catch (e) {
      // ほかの人が先に復元していた場合は、見張りで一覧から消えるので、何も出さない
      if (!(e instanceof ConflictError)) {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busyId.set(null);
    }
  }

  /** 元に戻せないので、必ず確かめてから消す */
  async purge(i: Issue) {
    if (!confirm(this.i18n.t('trash.purgeConfirm', { n: String(i.number), title: i.title }))) return;
    this.busyId.set(i.id);
    this.error.set('');
    this.restored.set(null);
    try {
      await this.issueService.purgeIssue(this.ctx.pid(), i.id);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busyId.set(null);
    }
  }

  /** メンバーが復元したときだけ、管理者に知らせる（管理者が戻したときは知らせない） */
  private adminsToNotify() {
    return this.ctx.role() === 'admin' ? [] : this.ctx.members().filter((m) => m.role === 'admin').map((m) => m.uid);
  }  

  memberName(uid: string) {
    return this.ctx.nameOf(uid);
  }

  when(i: Issue) {
    return i.deletedAt ? formatDateTime(i.deletedAt.toDate(), this.tz(), this.i18n.lang()) : '';
  }
}