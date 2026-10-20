import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AttachmentService } from '../../core/attachment/attachment.service';
import { AuthService } from '../../core/auth/auth.service';
import { DraftService, fieldPlace } from '../../core/draft/draft.service';
import { Activity, Attachment, MAX_PROJECT_FILES } from '../../core/models';
import { formatDateTime, relativeTime } from '../../core/time/time';
import { ProjectService } from '../../core/project/project.service';
import { Clock } from '../../core/time/clock';
import { I18nService, TPipe } from '../../i18n/i18n';
import { AttachmentList } from '../issue/attachment-list';
import { ProjectContext } from './project-context';
import { Avatar } from '../../shared/avatar';

/** 説明の中の URL（押せるようにする）。閉じかっこや「」は URL に含めない */
const URL_RE = /(https?:\/\/[^\s<>"'）」]+)/g;
const DAY = 24 * 60 * 60 * 1000;

/** プロジェクトの概要：説明・添付・今の様子・メンバー。説明と添付を変えるのは管理者 */
@Component({
  selector: 'app-tab-overview',
  imports: [FormsModule, RouterLink, TPipe, AttachmentList, Avatar],
  template: `
    <div class="layout">
      <div class="main">
        <section class="card">
          <h2>{{ 'overview.description' | t }}</h2>
          @if (editing()) {
            <textarea [ngModel]="draft" (ngModelChange)="draft = $event; stash()" rows="12" maxlength="5000"
              [attr.aria-label]="'overview.description' | t"></textarea>
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            <div class="row">
              <button type="button" class="link" (click)="cancelEdit()">{{ 'workflow.cancel' | t }}</button>
              <button type="button" class="primary" [disabled]="busy()" (click)="save()">{{ 'overview.save' | t }}</button>
            </div>
          } @else if (canEdit()) {
            <!-- 管理者：欄そのものを押して直す（中の URL を押したときは、リンクのほうを開く） -->
            <div class="text-btn" role="button" tabindex="0" [attr.aria-label]="'overview.editHint' | t"
              (click)="startEdit()" (keydown.enter)="startEdit()">
              @if (desc()) {
                <p class="desc">@for (s of segments(); track $index) {@if (s.url) {<a [href]="s.text" target="_blank" rel="noopener noreferrer" (click)="$event.stopPropagation()">{{ s.text }}</a>} @else {{{ s.text }}}}</p>
              } @else {
                <p class="empty">{{ 'overview.emptyAdmin' | t }}</p>
              }
            </div>
          } @else if (desc()) {
            <p class="desc">@for (s of segments(); track $index) {@if (s.url) {<a [href]="s.text" target="_blank" rel="noopener noreferrer">{{ s.text }}</a>} @else {{{ s.text }}}}</p>
          } @else {
            <p class="empty">{{ 'overview.empty' | t }}</p>
          }
        </section>

        <section class="card">
          <h2>{{ 'attach.title' | t }}</h2>
          @if (files().length || canEdit()) {
            <app-attachment-list [pid]="ctx.pid()" [iid]="null" [items]="files()" [canAdd]="canEdit()"
              [isAdmin]="ctx.role() === 'admin'" [archived]="ctx.archived()" [nameOf]="nameFn" [limit]="maxFiles" />
          } @else {
            <p class="empty">{{ 'overview.noFiles' | t }}</p>
          }
        </section>

        <section class="card">
          <h2>{{ 'overview.activity' | t }}</h2>
          <p class="help">{{ 'overview.activityHelp' | t }}</p>
          @if (acts().length) {
            <ul class="acts">
              @for (a of acts(); track a.id) {
                <li>
                  <div class="act-top">
                    <a class="act-issue" [routerLink]="['/p', ctx.pid(), 'i', a.iid]">#{{ a.number }} {{ a.title }}</a>
                    <span class="act-when" [title]="full(a)">{{ ago(a) }}</span>
                  </div>
                  <span class="act-text">{{ actText(a) }}</span>
                  @if (a.body) { <span class="act-body">{{ a.body }}</span> }
                </li>
              }
            </ul>
          } @else {
            <p class="empty">{{ 'overview.noActivity' | t }}</p>
          }
        </section>
      </div>

      <aside class="side">
        <section class="card">
          <h2>{{ 'overview.status' | t }}</h2>
          <dl class="nums">
            <div><dt>{{ 'dashboard.active' | t }}</dt><dd>{{ counts().active }}</dd></div>
            <div [class.bad]="counts().overdue > 0"><dt>{{ 'dashboard.overdue' | t }}</dt><dd>{{ counts().overdue }}</dd></div>
            <div><dt>{{ 'overview.week' | t }}</dt><dd>{{ counts().week }}</dd></div>
          </dl>
          <a class="link" [routerLink]="['/p', ctx.pid(), 'list']">{{ 'overview.toList' | t }}</a>
        </section>
        <section class="card">
          <h2>{{ 'overview.members' | t: { n: '' + members().length } }}</h2>
          <ul class="members">
            @for (m of members(); track m.uid) {
              <li>
                <app-avatar [name]="m.displayName" [uid]="m.uid" [photo]="m.photoURL" [size]="22" />
                <span class="nm">{{ m.displayName }}</span><span class="role">{{ 'roles.' + m.role | t }}</span>
              </li>
            }
          </ul>
          <a class="link" [routerLink]="['/p', ctx.pid(), 'members']">{{ 'overview.toMembers' | t }}</a>
        </section>
      </aside>
    </div>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; align-items: start; }
    @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
    .main, .side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .card { border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 15px; margin: 0 0 8px; }
    .desc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
    .desc a { color: var(--primary); }
    .empty { margin: 0; font-size: 13px; color: var(--text-muted); }
    /* 押すと直せる欄（課題の詳細と同じ見た目）。余白の分だけ外へずらし、押せない文字と頭をそろえる */
    .text-btn { margin: -6px -8px; padding: 5px 7px; border: 1px solid transparent; border-radius: 6px; cursor: text; }
    .text-btn:hover { border-color: var(--border-strong); background: var(--surface-alt); }
    .text-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
    textarea { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px 12px; line-height: 1.6; }
    .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 36px; font-size: 14px;
      cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
    .primary { min-height: 40px; padding: 0 18px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); font-size: 13px; }
    .nums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 8px; }
    .nums div { padding: 8px; border-radius: 8px; background: var(--surface-alt); text-align: center; }
    .nums dt { font-size: 11px; color: var(--text-muted); }
    .nums dd { margin: 4px 0 0; font-size: 20px; font-weight: bold; }
    .nums .bad dd { color: var(--danger-text); }
    .members { list-style: none; margin: 0 0 8px; padding: 0; max-height: 280px; overflow: auto; }
    .members li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0;
      border-bottom: 1px solid var(--border); font-size: 13px; }
    .nm { min-width: 0; overflow-wrap: anywhere; }
    .role { flex: none; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--chip-bg); }
    .help { margin: -4px 0 8px; font-size: 12px; color: var(--text-muted); }
    .acts { list-style: none; margin: 0; padding: 0; }
    .acts li { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .acts li:last-child { border-bottom: none; }
    .act-top { display: flex; align-items: baseline; gap: 8px; }
    .act-issue { flex: 1; min-width: 0; color: var(--text); text-decoration: none; font-size: 13px; font-weight: bold;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .act-issue:hover { color: var(--primary); text-decoration: underline; }
    .act-when { flex: none; font-size: 11px; color: var(--text-subtle); }
    .act-text { font-size: 13px; color: var(--text-secondary); }
    .act-body { font-size: 12px; color: var(--text-muted); padding-left: 8px; border-left: 2px solid var(--border-strong);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nm { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  `,
})
export class TabOverview {
  protected ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private attachments = inject(AttachmentService);
  private drafts = inject(DraftService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  private authService = inject(AuthService);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  

  readonly maxFiles = MAX_PROJECT_FILES;
  readonly nameFn = (uid: string) => this.ctx.nameOf(uid);
  files = signal<Attachment[]>([]);
  /** 直近の経緯（帳面の新しい20件） */
  acts = signal<Activity[]>([]);

  /** 書けるのは管理者（アーカイブ中は不可。プロジェクトの名前・設定と同じ） */
  canEdit = computed(() => this.ctx.role() === 'admin' && !this.ctx.archived());
  desc = computed(() => this.ctx.project()?.description?.trim() ?? '');
  /** 説明を、ふつうの文字と URL に分ける（URL だけ押せるように） */
  segments = computed(() => this.desc().split(URL_RE).filter(Boolean)
    .map((s) => ({ text: s, url: /^https?:\/\//.test(s) })));

  /** 今の様子：未完了・期限切れ・7日以内が期限（ダッシュボードと同じ数え方） */
  counts = computed(() => {
    const now = this.clock.now();
    const active = this.ctx.openIssues()
      .filter((i) => i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold');
    return {
      active: active.length,
      overdue: active.filter((i) => i.dueAt.toMillis() < now).length,
      week: active.filter((i) => i.dueAt.toMillis() >= now && i.dueAt.toMillis() - now <= 7 * DAY).length,
    };
  });

  /** メンバー：管理者 → メンバー → 閲覧者、同じ役割の中は名前順 */
  members = computed(() => {
    const rank = { admin: 0, member: 1, viewer: 2 } as const;
    return [...this.ctx.members()].sort((a, b) => rank[a.role] - rank[b.role] || a.displayName.localeCompare(b.displayName));
  });

  // ---- 説明の編集 ----
  editing = signal(false);
  draft = '';
  busy = signal(false);
  error = signal('');
  /** 書きかけの名札（課題の id の代わりに「-」） */
  private place = computed(() => fieldPlace(this.ctx.pid(), '-', 'description'));

  constructor() {
    const stops = [
      this.attachments.watch(this.ctx.pid(), null, (l) => this.files.set(l), (e) => console.error(e)),
      this.ps.watchActivity(this.ctx.pid(), 20, (l) => this.acts.set(l), (e) => console.error(e)),
    ];
    inject(DestroyRef).onDestroy(() => stops.forEach((s) => s()));
  }

  ago(a: Activity) {
    return relativeTime(a.at.toMillis(), this.i18n.lang(), this.clock.now());
  }

  full(a: Activity) {
    return formatDateTime(a.at.toDate(), this.tz(), this.i18n.lang());
  }

  /** 帳面の1行を文にする（課題の詳細の経緯と、同じ言葉を使う） */
  actText(a: Activity) {
    const name = this.ctx.nameOf(a.by);
    const t = (k: string, p: Record<string, string> = {}) => this.i18n.t(k, { name, ...p });
    if (a.kind === 'comment') return t('overview.act.comment');
    const field = (f: string) => this.i18n.t('issue.' + ({ assigneeId: 'assignee', dueAt: 'due' }[f] ?? f));
    switch (a.type) {
      case 'created': return t('detail.events.created');
      case 'imported': return t('detail.events.imported');
      case 'recurring': return this.i18n.t('detail.events.recurring');
      case 'status':
        return t('detail.events.status', { from: this.i18n.t('status.' + a.from), to: this.i18n.t('status.' + a.to) });
      case 'edit':
        return t('detail.events.edit', { fields: (a.fields ?? []).map(field).join(this.i18n.lang() === 'ja' ? '・' : ', ') });
      case 'priority': return t('overview.act.priority');
      case 'merge': return t('detail.events.merge', { n: String(a.merged?.number ?? '') });
      case 'subtask':
        return a.sub ? t('detail.events.subtask.' + a.sub.action, { title: a.sub.title, n: String(a.sub.number ?? '') }) : '';
      case 'attachment':
        return a.file ? t('attachment.' + a.file.action, { file: a.file.name }) : '';
      case 'link': {
        const l = a.link;
        if (!l) return '';
        const kind = this.i18n.t('links.groups.' + (l.kind === 'relates' ? 'relates' : `${l.kind}_${l.dir}`));
        const target = l.number != null && l.pid === this.ctx.pid() ? '#' + l.number : this.i18n.t('links.unreadable');
        return t('detail.events.link.' + l.action, { kind, target });
      }
      default: return t('overview.act.other');
    }
  }

  /** 直し始める：書きかけ → 今の説明 → 空なら雛形（【目的】【期間】【決まりごと】）の順 */
  startEdit() {
    this.draft = this.drafts.getText(this.place()) || this.desc() || this.i18n.t('overview.template');
    this.error.set('');
    this.editing.set(true);
  }

  stash() {
    this.drafts.setText(this.place(), this.draft);
  }

  /** やめる：書きかけを捨てる */
  cancelEdit() {
    this.drafts.clearText(this.place());
    this.editing.set(false);
  }

  async save() {
    const text = this.draft.trim();
    // 雛形のまま何も書いていなければ、空として保存する（中身のない見出しだけを残さない）
    const value = text === this.i18n.t('overview.template').trim() ? '' : text;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.setDescription(this.ctx.pid(), value);
      this.drafts.clearText(this.place());
      this.editing.set(false);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}