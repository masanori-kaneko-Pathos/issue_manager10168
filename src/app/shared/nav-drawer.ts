import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { ProjectService } from '../core/project/project.service';
import { PROJECT_FOLD, orderProjects } from '../core/project/project-order';
import { InboxService } from '../core/inbox/inbox.service';
import { Draft, DraftService } from '../core/draft/draft.service';
import { IssueFormService } from '../core/issue/issue-form.service';
import { RequestBadge } from '../core/request/request-badge.service';
import { ProjectWithRole, Reminder } from '../core/models';
import { ReminderHub, reminderTitle } from '../core/reminder/reminder-hub.service';
import { shortDue } from '../core/time/time';
import { I18nService, TPipe } from '../i18n/i18n';

type Sec = 'inbox' | 'reminders' | 'drafts' | 'projects';

/**
 * 引き出し（ヘッダーの ☰ から、左からすっと出る。どの画面でも）。ホーム・受信箱・下書き・プロジェクトへの近道。
 * 受信箱・下書き・プロジェクトは見出しを押すとたたむ・開く（端末に覚える）。開くと「すべて見る」→ ピン止め → ほか、の順。
 * お知らせと設定は、ヘッダーに入口があるので入れない（入口は1か所）。行き先を押す・外・Esc で閉じる
 */
@Component({
  selector: 'app-nav-drawer',
  imports: [RouterLink, TPipe],
  host: { '(document:keydown.escape)': 'close.emit()', '[animate.leave]': "'im-out-drawer'" },
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <nav class="drawer" role="dialog" aria-modal="true" [attr.aria-label]="'nav.title' | t">
      <div class="d-head">
        <!-- 押しても閉じる（✕ と同じ。指やマウスで、見出しのあたりを押して閉じる人のため） -->
        <span class="brand" (click)="close.emit()">{{ 'app.title' | t }}</span>
        <button type="button" class="x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t"
          (click)="close.emit()">✕</button>
      </div>

      <!-- 見出しと同じ形（▾ の場所に家の絵・太字）。文字の左端と太さをそろえる -->
      <a routerLink="/" class="item top" (click)="close.emit()">
        <svg class="slot" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor"
          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></svg>
        {{ 'crumbs.home' | t }}</a>
      <div class="sep" role="separator"></div>

      <!-- 受信箱 -->
      <div class="sec-row">
        <button type="button" class="sec" [attr.aria-expanded]="isOpen('inbox')" (click)="toggle('inbox')">
          <span class="tri" [class.shut]="!isOpen('inbox')" aria-hidden="true">▾</span>
          <span class="grow">{{ 'inbox.title' | t }}</span>
        </button>
        @if (isOpen('inbox')) { <a routerLink="/inbox" class="all" (click)="close.emit()">{{ 'nav.seeAll' | t }}</a> }
        @if (inbox.count()) { <span class="n">{{ inbox.count() }}</span> }
      </div>
      <div class="fold-body" [class.open]="isOpen('inbox')" [attr.inert]="isOpen('inbox') ? null : ''">
        <div class="sub">
          @for (m of memos(); track m.id) {
            <a class="item" routerLink="/inbox" [queryParams]="{ m: m.id }" [title]="m.title" (click)="close.emit()">
              <span class="mark">
                @if (m.pinned) {
                  <svg class="pin" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"
                    stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                    <path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>
                }
              </span>
              <span class="grow pname">{{ m.title }}</span></a>
          } @empty {
            <p class="small">{{ 'inbox.empty' | t }}</p>
          }
          @if (inbox.count() > memos().length) {
            <a routerLink="/inbox" class="item more" (click)="close.emit()">
              <span class="mark"></span>{{ 'nav.more' | t: { n: '' + (inbox.count() - memos().length) } }}</a>
          }
        </div>
      </div>

      <!-- リマインド（いつも出す。見るだけで、押すと窓が開く。届いたものは時刻が赤） -->
      <div class="sec-row">
        <button type="button" class="sec" [attr.aria-expanded]="isOpen('reminders')" (click)="toggle('reminders')">
          <span class="tri" [class.shut]="!isOpen('reminders')" aria-hidden="true">▾</span>
          <span class="grow">{{ 'reminder.title' | t }}</span>
        </button>
        @if (isOpen('reminders')) {
          <button type="button" class="all" (click)="openReminders()">{{ 'nav.seeAll' | t }}</button>
        }
        @if (remind.count()) { <span class="n">{{ remind.count() }}</span> }
      </div>
      <div class="fold-body" [class.open]="isOpen('reminders')" [attr.inert]="isOpen('reminders') ? null : ''">
        <div class="sub">
          @for (r of reminderList(); track r.id) {
            <button type="button" class="item" [title]="titleOf(r)" (click)="openReminder(r.id)">
              <span class="mark"></span>
              <span class="grow pname">{{ titleOf(r) }}</span>
              <span class="r-when" [class.late]="!r.pending">{{ when(r) }}</span></button>
          } @empty {
            <p class="small">{{ 'reminder.none' | t }}</p>
          }
          @if (remind.count() > reminderList().length) {
            <button type="button" class="item more" (click)="openReminders()">
              <span class="mark"></span>{{ 'nav.more' | t: { n: '' + (remind.count() - reminderList().length) } }}</button>
          }
        </div>
      </div>

      <!-- 下書き（1件以上あるときだけ） -->
      @if (drafts.count()) {
        <div class="sec-row">
          <button type="button" class="sec" [attr.aria-expanded]="isOpen('drafts')" (click)="toggle('drafts')">
            <span class="tri" [class.shut]="!isOpen('drafts')" aria-hidden="true">▾</span>
            <span class="grow">{{ 'drafts.title' | t }}</span>
          </button>
          @if (isOpen('drafts')) { <a routerLink="/drafts" class="all" (click)="close.emit()">{{ 'nav.seeAll' | t }}</a> }
          <span class="n">{{ drafts.count() }}</span>
        </div>
        <div class="fold-body" [class.open]="isOpen('drafts')" [attr.inert]="isOpen('drafts') ? null : ''">
          <div class="sub">
            @for (d of draftList(); track d.id) {
              <!-- 押すと続きを書く（課題は登録の窓、プロジェクトは作成の窓。下書きのページと同じ開き方） -->
              <button type="button" class="item" [title]="d.title" (click)="openDraft(d)">
                <span class="mark"></span>
                <span class="grow pname" [class.untitled]="!d.title">{{ d.title || ('drafts.untitled' | t) }}</span>
                <span class="role">{{ 'drafts.kinds.' + d.kind | t }}</span></button>
            }
            @if (drafts.count() > draftList().length) {
              <a routerLink="/drafts" class="item more" (click)="close.emit()">
                <span class="mark"></span>{{ 'nav.more' | t: { n: '' + (drafts.count() - draftList().length) } }}</a>
            }
          </div>
        </div>
      }

      <!-- プロジェクト（並びはプロジェクトのページで決めたもの。依頼があれば名前の左に赤い丸） -->
      <div class="sec-row">
        <button type="button" class="sec" [attr.aria-expanded]="isOpen('projects')" (click)="toggle('projects')">
          <span class="tri" [class.shut]="!isOpen('projects')" aria-hidden="true">▾</span>
          <span class="grow">{{ 'projects.title' | t }}</span>
          @if (badge.total()) { <span class="req-dot" role="img" [attr.aria-label]="'nav.hasRequests' | t"></span> }
        </button>
        @if (isOpen('projects')) { <a routerLink="/projects" class="all" (click)="close.emit()">{{ 'nav.seeAll' | t }}</a> }
        @if (activeCount()) { <span class="n">{{ activeCount() }}</span> }
      </div>
      <div class="fold-body" [class.open]="isOpen('projects')" [attr.inert]="isOpen('projects') ? null : ''">
        <div class="sub">
          @if (loading()) {
            <p class="small">{{ 'common.loading' | t }}</p>
          } @else {
            @for (p of shown(); track p.id) {
              <a class="item" [routerLink]="['/p', p.id]" [title]="p.name" (click)="close.emit()">
                <span class="mark">
                  @if (badge.counts()[p.id]) {
                    <span class="req-dot" role="img" [attr.aria-label]="'request.waiting' | t"></span>
                  } @else if (pins().has(p.id)) {
                    <svg class="pin" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="currentColor"
                      stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                      <path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>
                  }
                </span>
                <span class="grow pname">{{ p.name }}</span>
                <span class="role">{{ 'roles.' + p.role | t }}</span></a>
            } @empty {
              <p class="small">{{ 'projects.empty' | t }}</p>
            }
            @if (activeCount() > shown().length) {
              <a routerLink="/projects" class="item more" (click)="close.emit()">
                <span class="mark"></span>{{ 'nav.more' | t: { n: '' + (activeCount() - shown().length) } }}</a>
            }
          }
        </div>
      </div>
    </nav>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 左からすっと出る（閉じるときはすぐ消える） */
    @keyframes drawer-in { from { translate: -100% 0; } }
    .drawer { position: absolute; top: 0; bottom: 0; left: 0; width: min(300px, 85vw); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 2px; overflow-y: auto; scrollbar-gutter: stable;
      padding: 8px 8px calc(16px + env(safe-area-inset-bottom)); background: var(--surface); color: var(--text);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.2); animation: drawer-in 220ms var(--ease-out); }
    /* 閉じるとき：全体はふわっと消え、引き出しは左へ戻る */
    @keyframes drawer-out { to { translate: -100% 0; } }
    :host(.im-out-drawer) { animation: im-fade-out 200ms var(--ease-out) forwards; pointer-events: none; }
    :host(.im-out-drawer) .drawer { animation: drawer-out 200ms var(--ease-out) forwards; }
    .d-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px 12px; }
    .brand { font-weight: bold; font-size: 16px; cursor: pointer; user-select: none; }
    .x { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; color: var(--text-muted);
      font-size: 18px; cursor: pointer; }
    .x:hover { background: var(--surface-alt); }
    .item { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px; border-radius: 8px;
      color: var(--text); text-decoration: none; font-size: 15px; }
    .item:hover { background: var(--surface-alt); }
    /* ホーム：見出し（.sec）と同じ太さ。絵は ▾ と同じ幅の場所に置く */
    .item.top { font-weight: bold; }
    .slot { flex: none; width: 12px; }
    /* 見出し（押すとたたむ・開く） */
    /* 見出しの行：たたむボタン（左いっぱい）＋ すべて見る ＋ 件数 */
    .sec-row { display: flex; align-items: center; gap: 6px; padding-right: 12px; border-radius: 8px; }
    .sec-row:hover { background: var(--surface-alt); }
    .sec { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 0 0 12px;
      border: none; background: none; color: var(--text); font: inherit; font-size: 15px; font-weight: bold;
      text-align: left; cursor: pointer; }
    .all { flex: none; display: inline-flex; align-items: center; min-height: 32px; padding: 0 4px;
      color: var(--primary); font-size: 13px; text-decoration: none; }
    .all:hover { text-decoration: underline; }
    /* 三角は1つの絵を回す（たたむと右向き） */
    .tri { flex: none; display: inline-block; width: 12px; font-size: 11px; text-align: center;
      transition: rotate 160ms var(--ease-out); }
    .tri.shut { rotate: -90deg; }
    /* 中身は、見出しの文字にそろえて少し右へ */
    .sub { display: flex; flex-direction: column; gap: 2px; padding-left: 12px; }
    /* 下書きの行はボタン（リンクと同じ見た目にそろえる） */
    button.item { width: 100%; border: none; background: none; font: inherit; text-align: left; cursor: pointer; }
    /* さらに n 件（押すとページへ） */
    .sub .item.more { min-height: 36px; color: var(--primary); font-size: 13px; }
    .untitled { color: var(--text-muted); }
    .mark { flex: none; width: 13px; display: inline-flex; justify-content: center; }
    .grow { flex: 1; min-width: 0; }
    .pname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pin { flex: none; color: var(--primary); }
    /* 対応待ちの依頼：赤い丸 */
    .req-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .n { flex: none; font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px;
      background: var(--surface-alt); color: var(--text-muted); }
    .role { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--chip-bg); }
    /* 「すべて見る」をボタンで出すとき（リマインドは窓で開くので、リンクではない） */
    button.all { border: none; background: none; font: inherit; font-size: 13px; cursor: pointer; }
    /* リマインドの時刻。届いたものは赤 */
    .r-when { flex: none; font-size: 11px; color: var(--text-muted); white-space: nowrap; }
    .r-when.late { color: var(--danger-text); font-weight: bold; }
    .sep { height: 1px; margin: 8px 4px; background: var(--border); }
    .small { margin: 4px 12px; font-size: 13px; color: var(--text-muted); }
  `,
})
export class NavDrawer implements OnInit {
  close = output<void>();
  /** プロジェクトの下書きを開くとき。作成の窓はヘッダーが開く（引き出しは閉じて消えるので、ここには置けない） */
  openProjectDraft = output<string>();
  private issueForm = inject(IssueFormService);
  protected inbox = inject(InboxService);
  protected drafts = inject(DraftService);
  protected badge = inject(RequestBadge);
  private authService = inject(AuthService);
  private ps = inject(ProjectService);
  protected remind = inject(ReminderHub);
  private i18n = inject(I18nService);

  private projects = signal<ProjectWithRole[]>([]);
  loading = signal(true);

  /** 開いている見出し（端末ごとに覚える。最初はプロジェクトだけ開く） */
  private readonly openKey = `issuemanager.navOpen.${auth.currentUser!.uid}`;
  private opened = signal<Set<Sec>>((() => {
    try {
      const v = localStorage.getItem(this.openKey);
      return new Set<Sec>(v ? (JSON.parse(v) as Sec[]) : ['projects']);
    } catch {
      return new Set<Sec>(['projects']);
    }
  })());

  isOpen(s: Sec) {
    return this.opened().has(s);
  }

  toggle(s: Sec) {
    const next = new Set(this.opened());
    if (next.has(s)) next.delete(s);
    else next.add(s);
    this.opened.set(next);
    try {
      localStorage.setItem(this.openKey, JSON.stringify([...next]));
    } catch {
      // 覚えておけなくても、今は開け閉めできる
    }
  }

  pins = computed(() => new Set(this.authService.profile()?.pinnedProjects ?? []));
  /** 進行中のプロジェクトの数（見出しの件数。アーカイブ済みは数えない） */
  activeCount = computed(() => this.projects().filter((p) => !p.archived).length);
  /** プロジェクトのページと同じ並び（ピン止めが上・自分で並べた順）。8件まで（残りは「すべて見る」で） */
  shown = computed(() => orderProjects(this.projects(), this.authService.profile()?.pinnedProjects,
    this.authService.profile()?.projectOrder).slice(0, PROJECT_FOLD));
  /** 受信箱のメモ：ピン止めが上。8件まで */
  memos = computed(() => {
    const all = this.inbox.active();
    return [...all.filter((m) => m.pinned), ...all.filter((m) => !m.pinned)].slice(0, PROJECT_FOLD);
  });
  /** 下書き（新しい順。8件まで） */
  draftList = computed(() => this.drafts.drafts().slice(0, PROJECT_FOLD));

  /** リマインド：届いたもの（古い順）→ 予定（近い順）。8件まで */
  reminderList = computed(() => [...this.remind.fired(), ...this.remind.scheduled()].slice(0, PROJECT_FOLD));

  titleOf(r: Reminder) {
    return reminderTitle(r);
  }

  /** 狭い引き出しに合わせて、短い時刻で */
  when(r: Reminder) {
    return shortDue(r.at.toDate(), this.authService.profile()?.timeZone ?? 'Asia/Tokyo', this.i18n.lang(), Date.now());
  }

  /** 引き出しを閉じて、一覧の窓を開く */
  openReminders() {
    this.close.emit();
    this.remind.openList();
  }

  /** 引き出しを閉じて、そのリマインドの変更の画面を開く（終わったら一覧へ） */
  openReminder(id: string) {
    this.close.emit();
    this.remind.openEdit(id);
  }

  /** 続きを書く：課題は登録の窓、プロジェクトはヘッダーに作成の窓を開いてもらう */
  openDraft(d: Draft) {
    this.close.emit();
    if (d.kind === 'issue') this.issueForm.open(d.pid, { draft: d.id });
    else this.openProjectDraft.emit(d.id);
  }

  /** 開くたびに一覧を読む（参加・作成・ピン止めが、すぐ反映されるように）。依頼の印の見張りも合わせる */
  async ngOnInit() {
    try {
      this.projects.set(await this.ps.listMyProjects(auth.currentUser!.uid));
      this.badge.sync(this.projects());
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }
}