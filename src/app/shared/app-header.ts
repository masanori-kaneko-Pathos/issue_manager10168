import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { auth } from '../core/firebase';
import { AppNotification, Role } from '../core/models';
import { ProjectService } from '../core/project/project.service';
import { InboxService } from '../core/inbox/inbox.service';
import { NoticeOp, NotificationService } from '../core/notification/notification.service';
import { Clock } from '../core/time/clock';
import { relativeTime } from '../core/time/time';
import { I18nService, TPipe } from '../i18n/i18n';
import { HelpTip } from './help-tip';
import { SearchService } from '../core/search/search.service'
import { SearchBox } from './search-box';
import { ProjectNewDialog } from './project-new-dialog';
import { InboxPop } from './inbox-pop';
import { DraftService } from '../core/draft/draft.service';
import { Avatar } from './avatar';
import { SETTINGS_NAV } from './settings-nav';
import { NoticeActions } from './notice-actions';
import { IssueFormService } from '../core/issue/issue-form.service';
import { NavDrawer } from './nav-drawer';
import { RequestBadge } from '../core/request/request-badge.service';

@Component({
  selector: 'app-header',
  imports: [RouterLink, TPipe, HelpTip, SearchBox, ProjectNewDialog, InboxPop, Avatar, NoticeActions, NavDrawer],
  host: {
    '(document:keydown.escape)':
      'open.set(false); addOpen.set(false); bellOpen.set(false); rowMenu.set(null); penOpen.set(false)',
    '(document:keydown)': 'onKey($event)',
  },
  template: `
    <header class="app-header">
      <!-- 狭い画面だけ：押すと、左から引き出しが出る -->
      <button type="button" class="nav-btn" [attr.aria-label]="'nav.open' | t" [title]="'nav.open' | t"
        [attr.aria-expanded]="navOpen()" (click)="navOpen.set(true)">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        <!-- 自分が管理者のプロジェクトに、対応待ちの依頼があるとき -->
        @if (badge.total()) { <span class="nav-dot" role="img" [attr.aria-label]="'nav.hasRequests' | t"></span> }</button>
      <a routerLink="/" class="brand">{{ 'app.title' | t }}</a>
      <app-search-box />
      <div class="pen-wrap">
        <button type="button" class="pen" [attr.aria-expanded]="penOpen()" [attr.aria-label]="'inbox.pen' | t"
          [title]="'inbox.pen' | t" (click)="togglePen()">
          <span class="pen-icon" aria-hidden="true">✎</span>
        </button>
        @if (penOpen()) { <app-inbox-pop (close)="penOpen.set(false)" /> }
      </div>
      <div class="add">
        <button type="button" class="add-btn" [attr.aria-expanded]="addOpen()"
          [attr.aria-label]="'menu.add' | t" [title]="'menu.add' | t" (click)="toggleAdd()">＋</button>
        @if (addOpen()) {
          <div class="backdrop" (click)="addOpen.set(false)"></div>
          <div class="menu" role="menu">
            <button type="button" role="menuitem" class="primary-item" (click)="newIssue()">
              {{ 'menu.newIssue' | t }}</button>
            <!-- 下書きは、1件以上あるときだけ出す -->
            @if (drafts.count()) {
              <a routerLink="/drafts" role="menuitem" (click)="addOpen.set(false)">
                {{ 'drafts.menu' | t: { n: '' + drafts.count() } }}</a>
            }
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
      <div class="bell-wrap">
        <button type="button" class="bell" [attr.aria-expanded]="bellOpen()"
          [attr.aria-label]="'notify.title' | t" [title]="'notify.title' | t" (click)="toggleBell()">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          @if (notify.unread()) { <span class="badge">{{ notify.unread() }}</span> }
        </button>
        @if (bellOpen()) {
          <div class="backdrop" (click)="bellOpen.set(false)"></div>
          <div class="panel" role="dialog" [attr.aria-label]="'notify.title' | t">
            <div class="panel-head">
              <strong>{{ 'notify.title' | t }}</strong>
              <span class="head-links">
                <button type="button" class="link" [disabled]="!notify.unread()" (click)="notify.markAllRead()">
                  {{ 'notify.allRead' | t }}</button>
                <a routerLink="/notifications" class="link" (click)="bellOpen.set(false)">{{ 'notify.seeAll' | t }}</a>
              </span>
            </div>
            <ul>
              @for (n of notify.list(); track n.id) {
                <li class="n-row">
                  <button type="button" class="n-item" [class.unread]="!n.read" (click)="openNotice(n)">
                    @if (!n.read) { <span class="dot" role="img" [attr.aria-label]="'notify.unread' | t"></span> }
                    <span class="n-text">@if (n.pinned) {<svg class="pin-mark" viewBox="0 0 24 24" width="13" height="13" role="img" [attr.aria-label]="'notify.pinned' | t" fill="currentColor"><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" stroke="currentColor" stroke-width="2" /></svg> }{{ notify.text(n) }}</span>
                    @if (n.detail) { <span class="n-detail">{{ n.detail }}</span> }
                    <span class="n-meta">{{ n.projectName ? n.projectName + ' · ' : '' }}{{ noticeWhen(n) }}</span>
                  </button>

                  <!-- PC：行に乗せたときだけ出るアイコン（メニューを開く1手を省く） -->
                  <app-notice-actions class="n-hover" [notice]="n" (act)="act(n, $event)" />

                  <!-- スマホ：乗せる操作がないので ⋮ のまま -->
                  <button type="button" class="n-more" [attr.aria-label]="'notify.actions' | t" [title]="'notify.actions' | t"
                    [attr.aria-expanded]="rowMenu() === n.id" (click)="toggleRowMenu(n.id, $event)">⋮</button>
                  @if (rowMenu() === n.id) {
                    <div class="n-backdrop" (click)="rowMenu.set(null)"></div>
                    <div class="n-menu" role="menu" [class.up]="rowMenuUp()">
                      <button type="button" role="menuitem" (click)="act(n, n.read ? 'unread' : 'read')">
                        {{ (n.read ? 'notify.markUnread' : 'notify.markRead') | t }}</button>
                      <button type="button" role="menuitem" (click)="act(n, n.pinned ? 'unpin' : 'pin')">
                        {{ (n.pinned ? 'notify.unpin' : 'notify.pin') | t }}</button>
                      <button type="button" role="menuitem" class="danger" (click)="act(n, 'delete')">
                        {{ 'notify.delete' | t }}</button>
                    </div>
                  }
                </li>
              } @empty {
                <li class="empty">{{ 'notify.empty' | t }}</li>
              }
            </ul>
          </div>
        }
      </div>
      <div class="account">
        <button type="button" class="account-btn" [attr.aria-expanded]="open()"
          [attr.aria-label]="'menu.account' | t" (click)="toggleAccount()">
          <app-avatar [name]="name()" [uid]="myUid" [photo]="photo()" [size]="28" />
          <span class="gear" aria-hidden="true">⚙</span>
        </button>

        @if (open()) {
          <div class="backdrop" (click)="open.set(false)"></div>
          <div class="menu" role="menu">
            <div class="who">
              <strong>{{ name() }}</strong>
              <span>{{ email() }}</span>
            </div>
            <!-- 設定の索引と同じ並び。押すと、そのページへ直接 -->
            @for (s of settingsNav; track s.path) {
              <a [routerLink]="['/settings', s.path]" role="menuitem" class="nav-item" (click)="open.set(false)">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="s.icon" /></svg>
                {{ s.key | t }}</a>
            }
            <div class="sep" role="separator"></div>
            <button type="button" role="menuitem" (click)="logout()">{{ 'common.logout' | t }}</button>
          </div>
        }
      </div>
    </header>
    @if (inbox.flash(); as key) { <div class="toast" role="status">{{ key | t }}</div> }
    @if (projectNewOpen()) {
      @defer (on immediate) {
        @if (projectDraftId(); as id) {
          <!-- 引き出しから開いた、プロジェクトの下書き -->
          <app-project-new-dialog [draftId]="id" (close)="closeProjectNew()" />
        } @else {
          <app-project-new-dialog (close)="closeProjectNew()" />
        }
      }
    }
    @if (navOpen()) {
      @defer (on immediate) {
        <app-nav-drawer (close)="navOpen.set(false)" (openProjectDraft)="openProjectDraft($event)" />
      }
    }
  `,
  styles: `
    .app-header { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 8px;
      height: 52px; padding: 0 12px; background: var(--primary); color: var(--on-primary); }
    .brand { color: var(--on-primary); text-decoration: none; font-weight: bold; font-size: 16px; }
    /* ☰：どの画面でも。押すと、左から引き出し（ホーム・受信箱・下書き・プロジェクト） */
    .nav-btn { position: relative; display: inline-flex; width: 36px; height: 36px; padding: 0; border: none; border-radius: 50%;
      align-items: center; justify-content: center; background: none; color: var(--on-primary); cursor: pointer; }
    .nav-btn:hover { background: rgba(255, 255, 255, 0.15); }
    /* 依頼の印：赤い丸に白いふち（青い帯の上でも見える） */
    .nav-dot { position: absolute; top: 4px; right: 4px; width: 10px; height: 10px; border-radius: 50%;
      background: var(--danger); box-shadow: 0 0 0 2px var(--on-primary); }
    .spacer { flex: 1; }
    .add-btn { width: 36px; height: 36px; border-radius: 50%; border: none; background: var(--on-primary);
      color: var(--primary); font-size: 22px; font-weight: bold; line-height: 1; cursor: pointer; }
    .pen { position: relative; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center;
      justify-content: center; color: var(--on-primary); text-decoration: none; font-size: 20px;
      background: rgba(255, 255, 255, 0.15); }
    .pen-icon { display: inline-block; transform: scaleX(-1); }
    .badge { position: absolute; top: -4px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px;
      border-radius: 9px; background: var(--on-primary); color: var(--primary); font-size: 11px; font-weight: bold;
      line-height: 18px; text-align: center; box-sizing: border-box; }
    .toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
      z-index: 200; padding: 10px 18px; border-radius: 20px; background: var(--text); color: var(--surface);
      font-size: 14px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); }
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
    .menu .nav-item { display: flex; align-items: center; gap: 10px; }
    .menu .nav-item svg { flex: none; color: var(--text-muted); }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .bell-wrap { position: relative; }
    .bell { position: relative; width: 36px; height: 36px; padding: 0; border: none; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; color: var(--on-primary);
      background: rgba(255, 255, 255, 0.15); cursor: pointer; }
    .panel { position: absolute; right: 0; top: calc(100% + 6px); z-index: 52; width: min(360px, calc(100vw - 24px));
      max-height: 70vh; overflow: auto; background: var(--surface); color: var(--text); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    /* 止まる見出し。行（position: relative）より上に描く（重なりを決めないと、後に書いた行が上に描かれて透ける） */
    .panel-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .panel-head .link { background: none; border: none; color: var(--primary); min-height: 36px; font-size: 13px;
      cursor: pointer; }
    .panel-head .link:disabled { color: var(--text-disabled); cursor: default; }
    .panel ul { list-style: none; margin: 0; padding: 0; }
    .n-item { position: relative; display: flex; flex-direction: column; gap: 2px; width: 100%;
      padding: 10px 12px 10px 26px; text-align: left; background: none; border: none;
      border-bottom: 1px solid var(--border); color: var(--text); font-size: 13px; line-height: 1.5; cursor: pointer; }
    .n-item:hover { background: var(--surface-alt); }
    .n-item.unread .n-text { font-weight: bold; }
    .dot { position: absolute; left: 10px; top: 17px; width: 8px; height: 8px; border-radius: 50%;
      background: var(--primary); }
    .n-detail { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; }
    .n-meta { font-size: 11px; color: var(--text-muted); }
    .panel .empty { padding: 16px 12px; color: var(--text-muted); font-size: 13px; }
    .n-row { position: relative; }
    .n-row .n-item { padding-right: 40px; }
    .n-more { position: absolute; top: 6px; right: 4px; width: 32px; height: 32px; border: none; border-radius: 6px;
      background: none; color: var(--text-muted); font-size: 16px; cursor: pointer; }
    .n-more:hover { background: var(--surface-muted); }
    .n-backdrop { position: fixed; inset: 0; z-index: 2; }
    /* ⋮ の横に出す（下の行にはかぶさらない）。右に空きがなければ ⋮ の左に */
    .n-menu { position: absolute; top: 6px; left: calc(100% + 4px); z-index: 3; min-width: 160px; padding: 6px 0;
      display: flex; flex-direction: column; background: var(--surface); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .n-menu.left { left: auto; right: 40px; }
    /* 小窓の下のほうの行では、下にはみ出して切れるので、行の下端にそろえて上へ伸ばす */
    .n-menu.up { top: auto; bottom: 6px; }
    .n-menu button { text-align: left; padding: 0 16px; min-height: 40px; background: none; border: none;
      color: var(--text); font-size: 13px; cursor: pointer; }
    .n-menu button:hover { background: var(--surface-alt); }
    .n-menu .danger { color: var(--danger-text); }
    .head-links { display: flex; align-items: center; gap: 12px; }
    .panel-head a.link { display: inline-flex; align-items: center; min-height: 36px; font-size: 13px;
      color: var(--primary); text-decoration: none; }
    .pen-wrap { position: relative; }
    .pen { border: none; padding: 0; cursor: pointer; }
    .pin-mark { vertical-align: -1px; margin-right: 4px; color: var(--primary); }
    /* 乗せたときのアイコン：ふだんは隠す */
    .n-hover { display: none; }
    /* マウスを乗せられる端末だけ：⋮ を消し、乗せた行（キーボードで移った行も）の右下にアイコンを出す */
    @media (hover: hover) and (pointer: fine) {
      .n-more { display: none; }
      .n-row .n-item { padding-right: 12px; }
      .n-row:hover .n-item { background: var(--surface-alt); }
      .n-row:hover .n-hover, .n-row:focus-within .n-hover {
        display: flex; gap: 2px; position: absolute; right: 8px; bottom: 6px; padding: 2px;
        border-radius: 8px; background: var(--surface-alt); }
    }
    @media (max-width: 600px) {
      .panel { position: fixed; left: 12px; right: 12px; top: 58px; width: auto; }
    }
  `,
})
export class AppHeader {
  private authService = inject(AuthService);
  private router = inject(Router);
  private projectService = inject(ProjectService);
  /** 受信箱（件数と、保存したときの知らせ） */
  protected inbox = inject(InboxService);
  /** お知らせ（件数・一覧・既読） */
  protected notify = inject(NotificationService);
  /** 下書き（件数を＋のメニューに出す） */
  protected drafts = inject(DraftService);
  private issueForm = inject(IssueFormService);
  /** 対応待ちの依頼（☰ の右上の印） */
  protected badge = inject(RequestBadge);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  bellOpen = signal(false);
  /** 引き出しが開いているか */
  navOpen = signal(false);
  /** ペンの吹き出し（開け閉めは受信箱のサービスが持つ。ホームや受信箱のページからも開くため） */
  penOpen = this.inbox.penOpen;

  togglePen() {
    this.open.set(false);
    this.addOpen.set(false);
    this.bellOpen.set(false);
    this.penOpen.set(!this.penOpen());
  }
  /** ベルの一覧で ⋮ を開いている通知 */
  rowMenu = signal<string | null>(null);
  /** 行の ⋮ のメニューを、上へ伸ばすか（小窓の下のほうでは、下にはみ出して切れるため） */
  rowMenuUp = signal(false);
  /** ⋮ の左に出すか（右に空きがないとき。小窓は画面の右端にあるので、PC ではたいてい左） */
  rowMenuLeft = signal(false);

  toggleRowMenu(id: string, e: MouseEvent) {
    if (this.rowMenu() === id) {
      this.rowMenu.set(null);
      return;
    }
    const btn = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const panel = (e.currentTarget as HTMLElement).closest('.panel')?.getBoundingClientRect();
    // 下に、メニュー（約130px）が入る空きがあるか。右に、メニュー（約170px）が入る空きがあるか
    this.rowMenuUp.set(!!panel && panel.bottom - btn.top < 140);
    this.rowMenuLeft.set(window.innerWidth - btn.right < 180);
    this.rowMenu.set(id);
  }
  private searchBox = viewChild(SearchBox);
  projectNewOpen = signal(false);
  /** 引き出しから開いた、プロジェクトの下書き（作成の窓に入れて開く） */
  projectDraftId = signal<string | null>(null);

  openProjectDraft(id: string) {
    this.projectDraftId.set(id);
    this.projectNewOpen.set(true);
  }

  /** 作成の窓を閉じる（下書きを入れて開いていたら、それも忘れる。次に＋から開くときは、まっさらで） */
  closeProjectNew() {
    this.projectNewOpen.set(false);
    this.projectDraftId.set(null);
  }

  addOpen = signal(false);
  /** メニューを開いたときにいたプロジェクトと、そこでの自分のロール */
  ctx = signal<{ pid: string | null; role: Role | null; sample: boolean }>({ pid: null, role: null, sample: false });
  canInvite = computed(() => !!this.ctx().pid && this.ctx().role === 'admin' && !this.ctx().sample);
  inviteDenied = computed(() => !this.ctx().pid ? 'menu.inviteNeedProject'
    : this.ctx().sample ? 'sample.noInvite' : 'menu.inviteNeedAdmin');

  open = signal(false);
  name = computed(() => this.authService.profile()?.displayName || this.authService.user()?.email || '');
  email = computed(() => this.authService.user()?.email ?? '');
  /** 自分のアイコン（設定で入れた写真 → なければ Google の写真 → なければ頭文字） */
  photo = computed(() => this.authService.myPhoto());
  readonly myUid = auth.currentUser?.uid ?? '';
  /** アカウントのメニューに並べる、設定の索引 */
  readonly settingsNav = SETTINGS_NAV;

  async logout() {
    this.open.set(false);
    await this.authService.logout();
    await this.router.navigateByUrl('/login');
  }
  private currentPid(): string | null {
    return this.router.url.match(/^\/p\/([^/?#]+)/)?.[1] ?? null;
  }

  toggleAccount() {
    this.penOpen.set(false);
    this.addOpen.set(false);
    this.bellOpen.set(false);
    this.open.set(!this.open());
  }

  /** 開くときに、今いるプロジェクトでの自分のロールを確かめる */
  async toggleAdd() {
    if (this.addOpen()) {
      this.addOpen.set(false);
      return;
    }
    this.open.set(false);
    this.penOpen.set(false);
    this.bellOpen.set(false);
    const pid = this.currentPid();
    let role: Role | null = null;
    let sample = false;
    if (pid) {
      try {
        const [r, p] = await Promise.all([
          this.projectService.myRole(pid, auth.currentUser!.uid),
          this.projectService.get(pid),
        ]);
        role = r;
        sample = !!p?.sample;
      } catch {
        role = null;
      }
    }
    this.ctx.set({ pid, role, sample });
    this.addOpen.set(true);
  }

  /** プロジェクトの中にいるときは、そのプロジェクトを選んだ状態で開く */
  newIssue() {
    this.addOpen.set(false);
    this.issueForm.open(this.currentPid());
  }

  newProject() {
    this.addOpen.set(false);
    this.projectNewOpen.set(true);
  }

  invite() {
    const pid = this.ctx().pid;
    this.addOpen.set(false);
    if (pid) this.router.navigate(['/p', pid, 'members'], { fragment: 'invite' });
  }

  /** 「/」で検索欄へ。文字を打っている途中や、ほかのキーと一緒に押したときは何もしない */
  onKey(e: KeyboardEvent) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    e.preventDefault(); // 「/」が入力欄に入らないように
    this.open.set(false);
    this.addOpen.set(false);
    this.bellOpen.set(false);
    this.penOpen.set(false);
    this.searchBox()?.focusFromKey();
  }

  toggleBell() {
    this.open.set(false);
    this.penOpen.set(false);
    this.addOpen.set(false);
    this.bellOpen.set(!this.bellOpen());
  }

  /** ⋮ の操作。済んだら ⋮ を閉じる（小窓は開いたまま） */
  async act(n: AppNotification, op: NoticeOp) {
    this.rowMenu.set(null);
    await this.notify.apply(n.id, op).catch((e) => console.error(e));
  }

  /** 「5分前」のような表示（時計で進むので、開いたままでも更新される） */
  noticeWhen(n: AppNotification) {
    return relativeTime(n.at.toMillis(), this.i18n.lang(), this.clock.now());
  }

  /** 既読にして、その課題へ（招待の承諾はプロジェクトへ） */
  /** 既読にして、その行き先へ（行き先の決まりはサービスにある） */
  async openNotice(n: AppNotification) {
    this.bellOpen.set(false);
    this.rowMenu.set(null);
    if (!n.read) this.notify.markRead(n.id).catch((e) => console.error(e));
    const t = this.notify.target(n);
    await this.router.navigate(t.commands, t.extras);
  }
}