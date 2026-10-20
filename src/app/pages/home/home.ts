import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Unsubscribe } from 'firebase/firestore';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectNewDialog } from '../../shared/project-new-dialog';
import { SearchService } from '../../core/search/search.service';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { Invitation, Issue, Level, ProjectWithRole } from '../../core/models';
import { IssueService } from '../../core/issue/issue.service';
import { InboxService } from '../../core/inbox/inbox.service';
import { Clock } from '../../core/time/clock';
import { PriorityMark } from '../../shared/priority-mark';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { DueBucket, dueBucket, remainingOf, shortDue } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { DeleteProjectDialog } from '../project/delete-project-dialog';
import { RequestService } from '../../core/request/request.service';
import { Router } from '@angular/router';
import { SampleService } from '../../core/project/sample.service';

@Component({
  selector: 'app-home',
  imports: [RouterLink, TPipe, PriorityMark, ProjectNewDialog, DeleteProjectDialog],
  template: `
   

    <main>
      @if (removedFrom() !== null) {
        <div class="notice" role="status">
          <p>{{ removedFrom()
            ? ('projects.removedNotice' | t: { project: removedFrom()! })
            : ('projects.removedNoticeUnknown' | t) }}</p>
          <button type="button" class="link" (click)="removedFrom.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (leftFrom() !== null) {
        <div class="notice" role="status">
          <p>{{ 'projects.leftNotice' | t: { project: leftFrom()! } }}</p>
          <button type="button" class="link" (click)="leftFrom.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (deletedProject(); as d) {
        <div class="notice" role="status">
          <p>{{ (d.byMe ? 'deleteProject.done' : 'deleteProject.gone') | t: { name: d.name } }}</p>
          <button type="button" class="link" (click)="deletedProject.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (needsVerify()) {
        <div class="notice">
          <p>{{ 'verify.message' | t }}</p>
          <button type="button" class="link" (click)="resendVerification()">{{ 'verify.resend' | t }}</button>
          <button type="button" class="link" (click)="checkVerified()">{{ 'verify.done' | t }}</button>
          @if (info()) { <p>{{ info() | t }}</p> }
        </div>
      }

      @if (showIntro()) {
        <section class="intro" [attr.aria-label]="'intro.title' | t">
          <h2>{{ 'intro.title' | t }}</h2>
          <p class="lead">{{ 'intro.lead' | t }}</p>
          <ol class="steps">
            <li>{{ 'intro.step1' | t }}</li>
            <li>{{ 'intro.step2' | t }}</li>
            <li>{{ 'intro.step3' | t }}</li>
          </ol>
          <div class="intro-actions">
            <button type="button" class="primary" [disabled]="sampleBusy()" (click)="trySample()">
              {{ (sampleBusy() ? 'intro.making' : 'intro.trySample') | t }}</button>
            <button type="button" class="ghost" [disabled]="sampleBusy()" (click)="newOpen.set(true)">
              {{ 'projectNew.title' | t }}</button>
            <button type="button" class="link" [disabled]="sampleBusy()" (click)="later()">{{ 'intro.later' | t }}</button>
          </div>
          <p class="small">{{ 'intro.laterHelp' | t }}</p>
        </section>
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

      <section class="inbox">
        <div class="mine-head">
          <h2>{{ 'inbox.title' | t }}</h2>
          <button type="button" class="link write" (click)="inbox.openPen()">{{ 'inbox.write' | t }}</button>
        </div>
        <ul class="list">
          @for (m of inbox.active().slice(0, 3); track m.id) {
            <li class="memo">
              <a class="name" routerLink="/inbox" [queryParams]="{ m: m.id }">{{ m.title }}</a>
              @if (inbox.isOld(m)) { <span class="old">{{ 'inbox.old' | t }}</span> }
            </li>
          } @empty {
            <li class="empty">{{ 'inbox.empty' | t }}</li>
          }
        </ul>
        @if (inbox.count()) {
          <a routerLink="/inbox" class="link see-all">{{ 'inbox.seeAll' | t: { n: '' + inbox.count() } }}</a>
        }
      </section>

      <section class="mine" id="today">
        <div class="mine-head">
          <h2>{{ 'mine.title' | t }}</h2>
          <label class="check">
            <input type="checkbox" [checked]="showDone()" (change)="showDone.set(!showDone())" />
            {{ 'mine.showDone' | t }}
          </label>
        </div>
        <div class="today" role="group" [attr.aria-label]="'today.title' | t">
          <span class="today-title">{{ 'today.title' | t }}</span>
          @for (b of buckets; track b) {
            <button type="button" class="t-chip" [attr.data-b]="b" [class.on]="bucket() === b"
              [attr.aria-pressed]="bucket() === b" [disabled]="!todayCounts()[b]" (click)="toggleBucket(b)">
              @if (b === 'overdue') { <span class="bang" aria-hidden="true">!</span> }
              {{ 'today.buckets.' + b | t }} <strong>{{ todayCounts()[b] }}</strong>
            </button>
          }
          @if (oldMemos()) {
            <a routerLink="/inbox" class="t-chip">{{ 'today.oldMemos' | t }} <strong>{{ oldMemos() }}</strong></a>
          }
          @if (!hasToday()) { <span class="small">{{ 'today.none' | t }}</span> }
        </div>
        @if (bucket()) {
          <p class="small">{{ 'today.filtered.' + bucket() | t }}
            <button type="button" class="link" (click)="bucket.set(null)">{{ 'today.clear' | t }}</button></p>
        }
        <ul class="list">
          @for (i of visibleMine(); track i.id) {
            <li class="mine-item">
              @if (isActive(i)) {
                <app-priority-mark [level]="prio(i)" [manual]="manual(i)" showText />
              } @else {
                <span class="prio-none"></span>
              }
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
        @if (mySubtaskIssues().length) {
          <h3 class="sub-head">{{ 'mine.subtasks' | t: { n: '' + mySubtaskIssues().length } }}</h3>
          <ul class="list">
            @for (i of mySubtaskIssues(); track i.id) {
              <li class="mine-item">
                <a class="name" [routerLink]="['/p', i.projectId, 'i', i.id]">#{{ i.number }} {{ i.title }}</a>
                <span class="small">{{ projectName(i.projectId) }}</span>
              </li>
            }
          </ul>
        }        
      </section>

      <h2>{{ 'projects.title' | t }}</h2>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (loading()) {
        <p>{{ 'common.loading' | t }}</p>
      } @else {
        <ul class="list">
          @for (p of activeProjects(); track p.id) {
            <li>
              <a class="name" [routerLink]="['/p', p.id]">{{ p.name }}</a>
              @if (reqCount()[p.id]; as n) {
                <a class="req-chip" [routerLink]="['/p', p.id, 'requests']" [title]="'request.waiting' | t">
                  {{ 'request.homeChip' | t: { n: '' + n } }}</a>
              }
              <span class="role">{{ 'roles.' + p.role | t }}</span>
            </li>
          } @empty {
            <li class="empty first">
              <span>{{ 'projects.empty' | t }}</span>
              <button type="button" class="primary" (click)="newOpen.set(true)">{{ 'projectNew.title' | t }}</button>
            </li>
          }
        </ul>
        @if (archivedProjects().length) {
          <button type="button" class="link fold-btn" [attr.aria-expanded]="showArchived()"
            (click)="showArchived.set(!showArchived())">
            {{ 'archive.section' | t: { n: '' + archivedProjects().length } }}
            <span aria-hidden="true">{{ showArchived() ? '▴' : '▾' }}</span></button>
          @if (showArchived()) {
            <ul class="list">
              @for (p of archivedProjects(); track p.id) {
                <li class="archived">
                  <a class="name" [routerLink]="['/p', p.id]">{{ p.name }}</a>
                  <span class="role">{{ 'archive.kinds.' + (p.archiveKind ?? 'completed') | t }}</span>
                  <span class="role">{{ 'roles.' + p.role | t }}</span>
                  @if (p.role === 'admin') {
                    <div class="row-more">
                      <button type="button" class="row-more-btn" [attr.aria-expanded]="rowMenu() === p.id"
                        [attr.aria-label]="'project.menu' | t" [title]="'project.menu' | t"
                        (click)="toggleRowMenu(p.id, $event)">⋮</button>
                      @if (rowMenu() === p.id) {
                        <div class="backdrop" (click)="rowMenu.set(null)"></div>
                        <div class="menu" role="menu" [class.up]="rowMenuUp()">
                          <button type="button" role="menuitem" [disabled]="busy()" (click)="unarchive(p)">
                            {{ 'archive.unarchive' | t }}</button>
                          <div class="sep" role="separator"></div>
                          <button type="button" role="menuitem" class="danger"
                            (click)="rowMenu.set(null); deleteTarget.set(p)">{{ 'deleteProject.open' | t }}</button>
                        </div>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </main>
    @if (newOpen()) { <app-project-new-dialog (close)="newOpen.set(false)" /> }
        @if (deleteTarget(); as p) {
      <app-delete-project-dialog [pid]="p.id" [name]="p.name" [prefill]="!!p.sample" (done)="onDeleted($event)"
        (cancel)="deleteTarget.set(null)" />
    }
  `,
  styles: `
    .bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
    .bar h1 { font-size: 18px; margin: 0; flex: 1; }
    main { max-width: 640px; margin: 0 auto; padding: 16px; }
    .first { flex-direction: column; align-items: flex-start !important; gap: 8px; padding: 12px !important; }
    .primary { padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; }
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
    .inbox { margin-bottom: 24px; }
    .inbox a.link { text-decoration: none; display: inline-flex; align-items: center; min-height: 40px; }
    .memo { min-height: 44px !important; }
    .old { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--warning-bg); color: var(--warning-text); }
    .see-all { font-size: 13px; }
    .write { min-height: 40px; font-size: 14px; cursor: pointer; }
    .mine-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .check { display: flex; align-items: center; gap: 6px; font-size: 13px; min-height: 40px; }
    .mine-item { flex-wrap: wrap; }
    .mine-item .name { flex: 1; min-width: 50%; overflow-wrap: anywhere; }
    .mine-item app-priority-mark, .prio-none { width: 64px; flex: none; }
    .small { font-size: 12px; color: var(--text-muted); }
    .small.overdue { color: var(--danger); font-weight: bold; }
    .mine { scroll-margin-top: 64px; }
    .today { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 8px; }
    .today-title { font-size: 12px; color: var(--text-muted); margin-right: 4px; }
    .t-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 18px; background: var(--surface); color: var(--text);
      font-size: 13px; text-decoration: none; cursor: pointer; }
    .t-chip strong { font-size: 14px; }
    .t-chip.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .t-chip:disabled { color: var(--text-disabled); cursor: default; }
    .t-chip[data-b='overdue']:not(:disabled):not(.on) .bang,
    .t-chip[data-b='overdue']:not(:disabled):not(.on) strong { color: var(--danger-text); }
    .bang { font-weight: bold; }
    .fold-btn { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 14px; cursor: pointer; }
    .row-more { position: relative; }
    .row-more-btn { width: 36px; height: 36px; min-height: 36px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 18px; cursor: pointer; }
    .row-more-btn:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 220px;
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu button { text-align: left; padding: 0 16px; min-height: 44px; background: none; border: none;
      color: var(--text); font-size: 14px; cursor: pointer; }
    .menu button:hover:not(:disabled) { background: var(--surface-alt); }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .menu button.danger { color: var(--danger-text); font-weight: bold; }
    .menu button.danger:hover { background: var(--danger-bg); }
    .menu.up { top: auto; bottom: calc(100% + 4px); }
    .sub-head { font-size: 13px; color: var(--text-muted); margin: 16px 0 0; }  
    .req-chip { font-size: 12px; padding: 2px 10px; border-radius: 12px; text-decoration: none; white-space: nowrap;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .intro { margin-bottom: 24px; padding: 16px; border-radius: 12px; border: 1px solid var(--primary);
      background: var(--primary-bg); }
    .intro h2 { margin: 0 0 6px; }
    .intro .lead { margin: 0 0 8px; }
    .steps { margin: 0 0 12px; padding-left: 1.4em; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    .intro-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .ghost { padding: 0 16px; border: 1px solid var(--primary); border-radius: 8px; background: var(--surface);
      color: var(--primary); }
    `,
})
export class Projects implements OnInit {
  private authService = inject(AuthService);
  private projectService = inject(ProjectService);
  private issueService = inject(IssueService);
  private clock = inject(Clock);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  protected i18n = inject(I18nService);
  private route = inject(ActivatedRoute);
  protected inbox = inject(InboxService);

  /** 「自分の課題」の見張り。プロジェクトごとに1本（pid → やめる関数） */
  private mineStops = new Map<string, Unsubscribe>();
  /** 読めなくなったプロジェクト（同じプロジェクトに何度も張り直さないための印） */
  private mineFailed = new Set<string>();
  /** プロジェクトごとの、自分が担当の課題（pid → 課題） */
  private mineByProject = signal<Record<string, (Issue & { projectId: string })[]>>({});
  private stopInvitations: Unsubscribe | null = null;
  private requests = inject(RequestService);
  /** 管理者のプロジェクトごとの、対応待ちの依頼の見張り（pid → やめる関数） */
  private reqStops = new Map<string, Unsubscribe>();
  /** プロジェクトごとの、対応待ちの依頼の数 */
  reqCount = signal<Record<string, number>>({});

  constructor() {

    // 朝のまとめの通知から来たら、今日のまとめの欄まで動かす
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((f) => {
      if (f === 'today') setTimeout(() => document.getElementById('today')?.scrollIntoView({ block: 'start' }));
    });
    // ホームを離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => {
      this.mineStops.forEach((stop) => stop());
      this.reqStops.forEach((stop) => stop());
      this.stopInvitations?.();
    });
  }

  projects = signal<ProjectWithRole[]>([]);
  /** 進行中のプロジェクトと、アーカイブ済みのプロジェクト（アーカイブ済みは下にたたむ） */
  activeProjects = computed(() => this.projects().filter((p) => !p.archived));
  archivedProjects = computed(() => this.projects().filter((p) => p.archived));
  showArchived = signal(false);
  /** アーカイブ済みの行の ⋮（開いているプロジェクトの id） */
  rowMenu = signal<string | null>(null);
  /** メニューを上に開くか（ボタンが画面の下のほうにあって、下に開くと切れるとき） */
  rowMenuUp = signal(false);

  toggleRowMenu(pid: string, e: MouseEvent) {
    if (this.rowMenu() === pid) {
      this.rowMenu.set(null);
      return;
    }
    // ボタンの下に、メニュー（約140px）が収まる空きがあるか
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.rowMenuUp.set(window.innerHeight - r.bottom < 160);
    this.rowMenu.set(pid);
  }
  /** 削除のモーダルを開いているプロジェクト */
  deleteTarget = signal<ProjectWithRole | null>(null);

  /** アーカイブの解除（ホームから）。済んだら一覧を読み直す */
  async unarchive(p: ProjectWithRole) {
    this.rowMenu.set(null);
    this.busy.set(true);
    try {
      await this.projectService.unarchive(p.id, auth.currentUser!.uid, p.role);
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 削除し終わった（ホームにいるので移動はせず、知らせを出して一覧を読み直す） */
  async onDeleted(name: string) {
    this.deleteTarget.set(null);
    this.deletedProject.set({ name, byMe: true });
    await this.load();
  }
  invitations = signal<Invitation[]>([]);
  /** 見張りで届いた課題（担当が自分か、サブタスクの担当が自分） */
  private watchedMine = computed(() => Object.values(this.mineByProject()).flat());
  /** 自分が担当の課題（「自分の課題」と今日のまとめは、こちらだけを数える） */
  myIssues = computed(() => this.watchedMine().filter((i) => i.assigneeId === auth.currentUser!.uid));
  /** サブタスクだけ担当している、未完了の課題（親の担当も自分なら、上に出ているので除く・赤J） */
  mySubtaskIssues = computed(() => {
    const uid = auth.currentUser!.uid;
    return this.watchedMine()
      .filter((i) => i.assigneeId !== uid && this.isActive(i) && !this.archivedIds().has(i.projectId))
      .sort((a, b) => compareIssues(a, b, this.clock.now()));
  });
  showDone = signal(false);
  /** 今日のまとめの区分で、自分の課題を絞る（null＝絞らない） */
  bucket = signal<DueBucket | null>(null);
  readonly buckets: DueBucket[] = ['overdue', 'today', 'tomorrow', 'in3'];
  /** アーカイブ中のプロジェクト（今日のまとめには数えない） */
  private archivedIds = computed(() => new Set(this.projects().filter((p) => p.archived).map((p) => p.id)));
  /** 今日のまとめで数える課題か：未完了（未着手・対応中・保留）で、アーカイブ中でないプロジェクトのもの */
  private counts = (i: Issue & { projectId: string }) => this.isActive(i) && !this.archivedIds().has(i.projectId);
  /** 区分ごとの件数 */
  todayCounts = computed(() => {
    const now = this.clock.now();
    const c: Record<DueBucket, number> = { overdue: 0, today: 0, tomorrow: 0, in3: 0 };
    for (const i of this.myIssues()) {
      if (!this.counts(i)) continue;
      const b = dueBucket(i.dueAt.toMillis(), now, this.tz());
      if (b) c[b]++;
    }
    return c;
  });
  /** 7日以上たった、未整理のメモの数 */
  oldMemos = computed(() => this.inbox.active().filter((m) => this.inbox.isOld(m)).length);
  hasToday = computed(() => Object.values(this.todayCounts()).some((n) => n > 0) || this.oldMemos() > 0);
  /** 初期は自分の手が必要なもの（未着手・対応中・保留）。切り替えで解決済み・クローズも表示 */
  visibleMine = computed(() => {
    const now = this.clock.now();
    const bucket = this.bucket();
    return this.myIssues()
      // アーカイブ中のプロジェクトの課題は出さない（通知と集計から外す約束。プロジェクトを開けば見られる）
      .filter((i) => !this.archivedIds().has(i.projectId))
      .filter((i) => i.status !== 'deleted' && (this.showDone() || this.isActive(i)))
      .filter((i) => !bucket || (this.counts(i) && dueBucket(i.dueAt.toMillis(), now, this.tz()) === bucket))
      .sort((a, b) => compareIssues(a, b, now));
  });
  needsVerify = signal(false);
  info = signal('');
  /** プロジェクトから外されて戻ってきたときの知らせ（プロジェクト名。わからなければ空文字。知らせがなければ null） */
  removedFrom = signal<string | null>(
    ((history.state as Record<string, unknown> | null)?.['removedFrom'] as string | undefined) ?? null);
  /** 自分から抜けて戻ってきたときの知らせ（プロジェクト名） */
  leftFrom = signal<string | null>(
    ((history.state as Record<string, unknown> | null)?.['leftFrom'] as string | undefined) ?? null);
  /** プロジェクトが削除されて戻ってきたときの知らせ（byMe＝自分で消した） */
  deletedProject = signal<{ name: string; byMe: boolean } | null>((() => {
    const s = (history.state ?? {}) as Record<string, unknown>;
    return typeof s['deletedProject'] === 'string' ? { name: s['deletedProject'] as string, byMe: !!s['byMe'] } : null;
  })());
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  /** プロジェクトが1つもないときの「プロジェクトを作成」 */
  newOpen = signal(false);
  private search = inject(SearchService);
  private sample = inject(SampleService);
  private router = inject(Router);
  sampleBusy = signal(false);
  /**
   * ようこその箱：進行中のプロジェクトが0件（全部アーカイブした・外れた人も）で、届いている招待もなく、
   * 「後で見る」を押していないとき（招待が届いている人は、まず参加してもらう）
   */
  showIntro = computed(() => !this.loading() && !this.activeProjects().length && !this.invitations().length
    && !this.authService.profile()?.introHidden);

  /** 見本を作って、かんばんを開く */
  async trySample() {
    this.sampleBusy.set(true);
    this.error.set('');
    try {
      const pid = await this.sample.create();
      await this.router.navigate(['/p', pid, 'board']);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
      await this.load(); // 途中までできていれば、一覧に出す
    } finally {
      this.sampleBusy.set(false);
    }
  }

  /** 後で見る：箱を閉じる（設定の「イントロダクション」から、いつでも戻せる） */
  async later() {
    try {
      await this.authService.updateProfile({ introHidden: true });
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }

  ngOnInit() {
    // 外されたときの知らせは1回だけ。読んだら履歴から消し、再読み込みで出し直さない
    const { removedFrom, leftFrom, deletedProject, byMe, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    if (removedFrom !== undefined || leftFrom !== undefined || deletedProject !== undefined) {
      history.replaceState(rest, '');
    }
    const u = auth.currentUser!;
    this.needsVerify.set(!!u.email && !u.emailVerified);
    this.watchInvitations();
    // 「自分の課題」の見張りは、プロジェクト一覧を読んだあとに張る（load の中）
    this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      this.projects.set(await this.projectService.listMyProjects(auth.currentUser!.uid));
      this.syncMine();
      this.syncRequests();
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  /** 自分宛ての招待を見張る。メールの確認が済むまでは読めないので始めない */
  private watchInvitations() {
    const email = auth.currentUser!.email;
    if (!email || this.needsVerify() || this.stopInvitations) return;
    this.stopInvitations = this.projectService.watchMyInvitations(
      email,
      (list) => this.invitations.set(list),
      (e) => console.error('招待の見張りに失敗', e),
    );
  }

  /** 所属するプロジェクトに合わせて、「自分の課題」の見張りを張り直す（増えたら始め、なくなったらやめる） */
  private syncMine() {
    const uid = auth.currentUser!.uid;
    const pids = new Set(this.projects().map((p) => p.id));
    // 一覧からなくなったプロジェクトの見張りをやめる
    for (const pid of [...this.mineStops.keys()]) {
      if (!pids.has(pid)) this.stopMineIn(pid);
    }
    // 新しく増えたプロジェクトに見張りを張る
    for (const pid of pids) {
      if (this.mineStops.has(pid) || this.mineFailed.has(pid)) continue;
      this.mineStops.set(pid, this.issueService.watchMyIssuesIn(
        pid, uid,
        (issues) => this.mineByProject.update((m) => ({ ...m, [pid]: issues })),
        (e) => {
          console.error('自分の課題の見張りに失敗', pid, e);
          // 外された・抜けたプロジェクトの分だけ止める。ほかのプロジェクトの見張りは動き続ける
          this.mineFailed.add(pid);
          this.stopMineIn(pid);
          if (e.code === 'permission-denied') this.load();
        },
      ));
    }
  }

  /** 自分が管理者のプロジェクト（アーカイブ中は除く）だけ、依頼を見張る。増えたら始め、外れたらやめる */
  private syncRequests() {
    const pids = new Set(this.projects().filter((p) => p.role === 'admin' && !p.archived).map((p) => p.id));
    for (const [pid, stop] of [...this.reqStops]) {
      if (pids.has(pid)) continue;
      stop();
      this.reqStops.delete(pid);
      this.reqCount.update((m) => {
        const { [pid]: _gone, ...rest } = m;
        return rest;
      });
    }
    for (const pid of pids) {
      if (this.reqStops.has(pid)) continue;
      this.reqStops.set(pid, this.requests.watchOpen(pid,
        (list) => this.reqCount.update((m) => ({ ...m, [pid]: list.length })),
        (e) => console.error('依頼の見張りに失敗', pid, e)));
    }
  }

  /** 1つのプロジェクトの見張りをやめ、その課題を表示から外す */
  private stopMineIn(pid: string) {
    this.mineStops.get(pid)?.();
    this.mineStops.delete(pid);
    this.mineByProject.update((m) => {
      const { [pid]: _removed, ...rest } = m;
      return rest;
    });
  }

  async accept(inv: Invitation) {
    this.busy.set(true);
    try {
      await this.projectService.acceptInvitation(inv, auth.currentUser!);
      this.search.invalidate(); // 参加したプロジェクトも、検索に出るように
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
    this.watchInvitations();
    await this.load();
  }


  /** 同じチップをもう一度押すと、絞り込みを外す */
  toggleBucket(b: DueBucket) {
    this.bucket.set(this.bucket() === b ? null : b);
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
  manual(i: Issue) {
    return isManualPriority(i);
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}