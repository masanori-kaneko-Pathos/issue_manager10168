import { Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { Unsubscribe } from 'firebase/firestore';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { IssueService, SubtaskEdits } from '../../core/issue/issue.service';
import { Issue, MAX_SUBTASKS, Member, Reminder, Subtask } from '../../core/models';
import { dateKey, formatDateTime, shortDue, zonedTime } from '../../core/time/time';
import { enterKey } from '../../core/dom';
import { MemberSelect } from '../../shared/member-select';
import { I18nService, TPipe } from '../../i18n/i18n';
import { IssueFormService } from '../../core/issue/issue-form.service';

/**
 * 課題の詳細の「サブタスク」の欄。見張り・追加・□・行の編集・並べ替えを、この中で済ませる。
 * 詳細画面は「どこに置くか」と「だれが何をできるか」だけを渡す
 */
@Component({
  selector: 'app-subtask-list',
  imports: [FormsModule, RouterLink, CdkDropList, CdkDrag, CdkDragHandle, MemberSelect, TPipe],
  host: {
    // Esc：行の編集は捨てる、追加の欄は書きかけを残して閉じる
    '(document:keydown.escape)': 'menuFor.set(null); editing.set(null); hideAdd()',
    '(document:click)': 'onDocClick($event)',
  },
  template: `
    @if (counted().length) {
      <div class="head">
        <span class="count">{{ 'subtask.progress' | t: { done: '' + doneCount(), total: '' + counted().length } }}</span>
        <span class="bar" role="progressbar" aria-valuemin="0" [attr.aria-valuemax]="counted().length"
          [attr.aria-valuenow]="doneCount()"><span class="fill" [style.width.%]="pct()"></span></span>
      </div>
    }

    <ul class="list" cdkDropList [cdkDropListData]="list()" [cdkDropListDisabled]="!canEdit() || !!editing()"
      (cdkDropListDropped)="onDrop($event)">
      @for (s of list(); track s.id) {
        <li class="row" cdkDrag [cdkDragData]="s" [class.split]="!!s.splitTo" [class.done]="s.status === 'done'">
          @if (editing() === s.id) {
            <div class="edit row-edit">
              <input id="st-edit-title" [(ngModel)]="dTitle" maxlength="200" [attr.aria-label]="'subtask.name' | t"
                (keydown)="onEditKey($event, s)" />
              <div class="edit-row">
                <label>{{ 'issue.assignee' | t }}
                  <app-member-select [members]="members()" [value]="dAssignee()" (picked)="dAssignee.set($event)" />
                </label>
                <label>{{ 'issue.due' | t }}
                  <input type="date" [(ngModel)]="dDate" [max]="parentDueKey()" />
                </label>
              </div>
              <p class="help">{{ 'subtask.dueHelp' | t }}</p>
              <textarea [(ngModel)]="dMemo" rows="2" maxlength="2000" [placeholder]="'subtask.memo' | t"></textarea>
              <div class="actions">
                <button type="button" class="link" (click)="editing.set(null)">{{ 'workflow.cancel' | t }}</button>
                <button type="button" class="primary" [disabled]="busy() || !dTitle.trim()" (click)="saveEdit(s)">
                  {{ 'edit.save' | t }}</button>
              </div>
            </div>
          } @else {
            @if (canEdit()) {
              <span class="grip" cdkDragHandle [attr.aria-label]="'subtask.drag' | t" [title]="'subtask.drag' | t">⋮⋮</span>
            }
            <input type="checkbox" class="check" [checked]="s.status === 'done'" [disabled]="!canToggle(s) || busy()"
              [attr.aria-label]="'subtask.markDone' | t: { title: s.title }" (change)="toggleDone(s)" />
            <div class="main">
              @if (canEdit() && !s.splitTo) {
                <!-- 押すとその場で編集。ボタンにするのは題名とメモだけ（リンクや札はボタンの中に入れられないため） -->
                <button type="button" class="sub-open" [title]="'subtask.edit' | t" (click)="startEdit(s)">
                  <span class="title">{{ s.title }}</span>
                  @if (s.memo) { <span class="memo">{{ s.memo }}</span> }
                </button>
              } @else {
                <span class="title">{{ s.title }}</span>
                @if (s.splitTo; as sp) {
                  <a class="to" [routerLink]="['/p', pid(), 'i', sp.iid]">{{ 'subtask.splitTo' | t: { n: '' + sp.number } }}</a>
                }
                @if (s.memo) { <span class="memo">{{ s.memo }}</span> }
              }
              <span class="meta">
                @if (s.status === 'doing') { <span class="doing">{{ 'subtask.doing' | t }}</span> }
                <span>{{ nameOf()(s.assigneeId) }}</span>
                @if (s.dueAt) { <span [class.late]="late(s)">{{ dueText(s) }}</span> }
                @if (beyond(s)) { <span class="late">{{ 'subtask.beyondParent' | t }}</span> }
              </span>
            </div>
            @if (!s.splitTo && (canEdit() || canToggle(s))) {
              <div class="more-wrap">
                <button type="button" class="more" [attr.aria-label]="'subtask.menu' | t" [title]="'subtask.menu' | t"
                  [attr.aria-expanded]="menuFor() === s.id" (click)="menuFor.set(menuFor() === s.id ? null : s.id)">⋮</button>
                @if (menuFor() === s.id) {
                  <div class="backdrop" (click)="menuFor.set(null)"></div>
                  <div class="menu" role="menu" animate.leave="im-out">
                    @if (canToggle(s) && s.status !== 'done') {
                      <button type="button" role="menuitem" (click)="toggleDoing(s)">
                        {{ (s.status === 'doing' ? 'subtask.toTodo' : 'subtask.toDoing') | t }}</button>
                    }
                    @if (canEdit()) {
                      <button type="button" role="menuitem"
                        (click)="menuFor.set(null); issueForm.open(pid(), { splitOf: issue().id, sub: s.id })">
                        {{ 'subtask.split' | t }}</button>
                      <button type="button" role="menuitem" class="danger" (click)="remove(s)">{{ 'subtask.delete' | t }}</button>
                    }
                  </div>
                }
              </div>
            }
          }
        </li>
      }
    </ul>

    @if (canEdit()) {
      @if (full()) {
        <p class="help">{{ 'subtask.max' | t: { n: '' + max } }}</p>
      } @else if (adding()) {
        <!-- 足すときから、編集と同じ欄を出す（名前で Enter ならすぐ足せる。続けて足せるよう、開いたまま） -->
        <div class="edit add-form">
          <input id="st-add" [(ngModel)]="newTitle" maxlength="200" [placeholder]="'subtask.add' | t"
            [attr.aria-label]="'subtask.name' | t" [disabled]="busy()" (keydown)="onAddKey($event)" />
          <div class="edit-row">
            <label>{{ 'issue.assignee' | t }}
              <app-member-select [members]="members()" [value]="nAssignee()" (picked)="nAssignee.set($event)" />
            </label>
            <label>{{ 'issue.due' | t }}
              <input type="date" [(ngModel)]="nDate" [max]="parentDueKey()" />
            </label>
          </div>
          <p class="help">{{ 'subtask.dueHelp' | t }}</p>
          <textarea [(ngModel)]="nMemo" rows="2" maxlength="2000" [placeholder]="'subtask.memo' | t"></textarea>
          <div class="actions">
            <button type="button" class="link" (click)="closeAdd()">{{ 'workflow.cancel' | t }}</button>
            <button type="button" class="primary" [disabled]="busy() || !newTitle.trim()" (click)="add()">
              {{ 'subtask.addBtn' | t }}</button>
          </div>
        </div>
      } @else {
        <button type="button" class="open-add" (click)="openAdd()">{{ 'subtask.openAdd' | t }}</button>
      }
    }
    @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
  `,
  styles: `
    :host { display: block; }
    .head { display: flex; align-items: center; gap: 8px; min-height: 24px; }
    .count { font-size: 13px; color: var(--text-secondary); white-space: nowrap; }
    .bar { flex: 1; max-width: 200px; height: 6px; border-radius: 3px; background: var(--surface-muted); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--success); }
    .list { list-style: none; margin: 0; padding: 0; }
    .head + .list { margin-top: 4px; }
    .row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border);
      background: var(--surface); }
    .grip { padding: 2px 2px 0; color: var(--text-subtle); cursor: grab; user-select: none; touch-action: none; }
    .check { width: 18px; height: 18px; margin-top: 2px; flex: none; cursor: pointer; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .title { overflow-wrap: anywhere; }
    .done .title { color: var(--text-muted); }
    .split .title { text-decoration: line-through; color: var(--text-muted); }
    .to { font-size: 12px; }
    .memo { font-size: 12px; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--text-muted); }
    .doing { padding: 0 6px; border-radius: 8px; background: var(--primary-bg); color: var(--primary); }
    .late { color: var(--danger-text); font-weight: bold; }
    .remind { display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; border: 1px solid var(--primary);
      border-radius: 8px; background: var(--primary-bg); color: var(--primary); font-size: 12px; cursor: pointer; }
    .remind.late { border-color: var(--danger); background: var(--danger-bg); color: var(--danger-text); }
    .more-wrap { position: relative; }
    .more { width: 32px; height: 32px; border: none; background: none; border-radius: 6px; color: var(--text-muted);
      cursor: pointer; }
    .more:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 180px; background: var(--surface);
      border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); padding: 6px 0; display: flex; flex-direction: column; }
    .menu button, .menu a { display: block; text-align: left; padding: 0 16px; min-height: 40px; line-height: 40px;
      background: none; border: none; color: var(--text); text-decoration: none; font-size: 14px; cursor: pointer; }
    .menu button:hover, .menu a:hover { background: var(--surface-alt); }
    .menu .danger { color: var(--danger-text); }
    .edit { flex: 1; display: flex; flex-direction: column; gap: 8px; }
    .add-form { margin-top: 6px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; }
    .edit input, .edit textarea { font-size: 16px; padding: 6px 10px; }
    .edit-row { display: flex; flex-wrap: wrap; gap: 8px 16px; }
    .edit-row label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    .add { display: flex; gap: 8px; margin-top: 6px; }
    .add input { flex: 1; min-width: 0; min-height: 40px; font-size: 16px; padding: 0 10px; }
    .add-btn { min-height: 40px; padding: 0 14px; border: 1px solid var(--primary); border-radius: 8px;
      background: var(--surface); color: var(--primary); cursor: pointer; }
    .add-btn:disabled { border-color: var(--border-strong); color: var(--text-disabled); cursor: default; }
    .help { margin: 4px 0 0; font-size: 12px; color: var(--text-muted); }
    .error { color: var(--danger-text); font-size: 13px; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; cursor: pointer; }
    .primary { min-height: 40px; padding: 0 16px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); }
    .cdk-drag-preview { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2); }
    .cdk-drag-placeholder { opacity: 0.3; }
    .open-add { margin-top: 0; min-height: 36px; padding: 0 4px; border: none; background: none;
      color: var(--primary); font-size: 14px; cursor: pointer; }
    /* 題名とメモを押すと編集（文字の見た目のまま、乗せると薄い背景） */
    .sub-open { display: flex; flex-direction: column; gap: 2px; width: 100%; margin: -2px -4px; padding: 2px 4px;
      border: none; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left;
      cursor: pointer; }
    .sub-open:hover { background: var(--surface-alt); }
  `,
})
export class SubtaskList implements OnInit {
  pid = input.required<string>();
  issue = input.required<Issue>();
  /** 担当者にできる人（閲覧者を除いたメンバー） */
  members = input.required<Member[]>();
  /** 名前の引き方（抜けた人も「（退出）」つきで出せるよう、詳細画面のものを借りる） */
  nameOf = input.required<(uid: string) => string>();
  /** 全部を触れるか（親の課題を編集できる人） */
  canEdit = input(false);
  /** 自分が担当のサブタスクの □ を押せるか（管理者・メンバーで、親がまだ動いている） */
  canWork = input(false);
  /** 窓に渡すプロジェクト名 */
  projectName = input('');

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;
  private stop: Unsubscribe | null = null;
  protected issueForm = inject(IssueFormService);
  readonly max = MAX_SUBTASKS;

  list = signal<Subtask[]>([]);
  menuFor = signal<string | null>(null);
  editing = signal<string | null>(null);
  busy = signal(false);
  error = signal('');
  newTitle = '';
  /** 追加の欄の、担当者・期限（日付だけ）・メモ */
  nAssignee = signal('');
  nDate = '';
  nMemo = '';
  /** 追加の欄を開いているか（ふだんは「＋ サブタスクを追加」のボタンだけ） */
  adding = signal(false);
  // 行の編集中の値（1行ずつしか開かないので、入れ物は共通）
  dTitle = '';
  dAssignee = signal('');
  dDate = '';
  dMemo = '';

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  /** 進み具合に数えるもの（切り出したものは除く） */
  counted = computed(() => this.list().filter((s) => !s.splitTo));
  doneCount = computed(() => this.counted().filter((s) => s.status === 'done').length);
  pct = computed(() => (this.counted().length ? (this.doneCount() / this.counted().length) * 100 : 0));
  full = computed(() => this.list().length >= MAX_SUBTASKS);
  /** 期限に選べる最後の日（親の期限の日。見る人のタイムゾーンで） */
  parentDueKey = computed(() => dateKey(this.issue().dueAt.toDate(), this.tz()));

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stop?.();
    });
  }

  ngOnInit() {
    this.stop = this.issueService.watchSubtasks(this.pid(), this.issue().id,
      (list) => this.list.set(list),
      (e) => {
        console.error(e);
        this.error.set('common.loadError');
      });
  }

  /** □ を押せるか：全部を触れる人か、自分が担当のサブタスク。切り出したものは押せない */
  canToggle(s: Subtask) {
    return !s.splitTo && (this.canEdit() || (this.canWork() && s.assigneeId === this.myUid));
  }

  toggleDone(s: Subtask) {
    return this.run(() => this.issueService.setSubtaskStatus(
      this.pid(), this.issue().id, s.id, s.status === 'done' ? 'todo' : 'done', this.myUid));
  }

  toggleDoing(s: Subtask) {
    this.menuFor.set(null);
    return this.run(() => this.issueService.setSubtaskStatus(
      this.pid(), this.issue().id, s.id, s.status === 'doing' ? 'todo' : 'doing', this.myUid));
  }

  /** 最初の担当者：親の担当者（担当者になれなければ自分） */
  private defaultAssignee() {
    const i = this.issue();
    return this.members().some((m) => m.uid === i.assigneeId) ? i.assigneeId : this.myUid;
  }

  /** 追加の欄を開く。開いている行の編集は先に片づける（開く欄は1つだけ）。書きかけがあれば続きから */
  openAdd() {
    this.leaveEdit();
    if (!this.hasAddDraft()) {
      this.newTitle = '';
      this.nDate = '';
      this.nMemo = '';
      this.nAssignee.set(this.defaultAssignee());
    }
    this.adding.set(true);
    setTimeout(() => document.getElementById('st-add')?.focus());
  }

  /** やめる：書きかけを捨てて閉じる */
  closeAdd() {
    this.newTitle = '';
    this.nDate = '';
    this.nMemo = '';
    this.adding.set(false);
  }

  /** 書きかけを残して閉じる（Esc・外を押したとき） */
  hideAdd() {
    this.adding.set(false);
  }

  /** 追加の欄に、何か書いてあるか */
  private hasAddDraft() {
    return !!(this.newTitle.trim() || this.nDate || this.nMemo.trim());
  }

  /** 名前の欄で Enter：すぐ足す（続けて足せるよう、欄は開いたまま）。Esc は host でまとめて受ける */
  onAddKey(e: KeyboardEvent) {
    enterKey(e, () => this.add());
  }

  /** 追加の欄から離れる：名前があれば足して閉じる、なければ書きかけを残して閉じる */
  private leaveAdd() {
    if (!this.adding()) return;
    if (this.newTitle.trim()) this.add();
    this.hideAdd();
  }

  /** 行の編集から離れる：題名があれば保存、空なら捨てる（保存できたら saveEdit が閉じる） */
  private leaveEdit() {
    const id = this.editing();
    if (!id) return;
    const s = this.list().find((x) => x.id === id);
    if (!s || !this.dTitle.trim()) {
      this.editing.set(null);
      return;
    }
    this.saveEdit(s);
  }

  /**
   * 外を押したとき：開いている欄を片づける。
   * 開くボタン（題名・「＋ サブタスクを追加」）を押したときは何もしない
   * （開いたクリックがそのまま document まで届き、開いた瞬間に閉じてしまうため。片づけは開く側がする）。
   * メニュー・選び窓・確かめの窓の中も何もしない
   */
  onDocClick(e: MouseEvent) {
    const t = e.target as Element | null;
    if (!t || t.closest('.sub-open, .open-add, .menu, .backdrop, [role="dialog"]')) return;
    if (this.editing() && !t.closest('.row-edit')) this.leaveEdit();
    if (this.adding() && !t.closest('.add-form')) this.leaveAdd();
  }

  /** 足す。並びは一番下。期限は親の期限を超えない（直すときと同じ計算） */
  add() {
    const title = this.newTitle.trim();
    if (!title || this.full() || this.busy()) return;
    const order = (this.list().at(-1)?.order ?? 0) + 1;
    const assigneeId = this.nAssignee() || this.defaultAssignee();
    return this.run(async () => {
      await this.issueService.addSubtask(this.pid(), this.issue(),
        { title, assigneeId, dueAt: this.dueFrom(this.nDate), order, memo: this.nMemo.trim() }, this.myUid, this.tz());
      // 続けて足せるように、担当者は残し、ほかは空に戻す
      this.newTitle = '';
      this.nDate = '';
      this.nMemo = '';
      setTimeout(() => document.getElementById('st-add')?.focus());
    });
  }

  startEdit(s: Subtask) {
    // 開いている欄（ほかの行・追加の欄）を先に片づける。押したほうを開く
    this.leaveEdit();
    this.leaveAdd();
    this.menuFor.set(null);
    this.dTitle = s.title;
    this.dAssignee.set(s.assigneeId);
    this.dDate = s.dueAt ? dateKey(s.dueAt.toDate(), this.tz()) : '';
    this.dMemo = s.memo;
    this.editing.set(s.id);
    setTimeout(() => document.getElementById('st-edit-title')?.focus());
  }

  onEditKey(e: KeyboardEvent, s: Subtask) {
    enterKey(e, () => this.saveEdit(s));
  }

  /** 変えた欄だけを保存する。何も変えていなければ、保存せずに閉じる */
  saveEdit(s: Subtask) {
    const edits: SubtaskEdits = {};
    const title = this.dTitle.trim();
    if (!title) return;
    if (title !== s.title) edits.title = title;
    if (this.dAssignee() && this.dAssignee() !== s.assigneeId) edits.assigneeId = this.dAssignee();
    const due = this.dueFrom(this.dDate);
    if ((due?.getTime() ?? null) !== (s.dueAt?.toMillis() ?? null)) edits.dueAt = due;
    if (this.dMemo.trim() !== s.memo) edits.memo = this.dMemo.trim();
    if (!Object.keys(edits).length) {
      this.editing.set(null);
      return;
    }
    return this.run(async () => {
      await this.issueService.updateSubtask(this.pid(), this.issue(), s, edits, this.myUid);
      // 保存のあいだに、ほかの行や追加の欄を開いていたら、そちらは閉じない
      if (this.editing() === s.id) this.editing.set(null);
    });
  }

  /**
   * 日付だけの期限を、その日の 23:59 にする。親の期限と同じ日なら、親の期限の時刻にそろえる
   * （親が 18:00 なのに 23:59 にすると「親より後」になり、ルールに断られるため）
   */
  private dueFrom(key: string): Date | null {
    const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const endOfDay = zonedTime(+m[1], +m[2], +m[3], 23, 59, this.tz()).getTime();
    return new Date(Math.min(endOfDay, this.issue().dueAt.toMillis()));
  }

  /** 消すのは元に戻せないので、確かめてから（消したことは経緯に残る） */
  remove(s: Subtask) {
    this.menuFor.set(null);
    if (!confirm(this.i18n.t('subtask.deleteConfirm', { title: s.title }))) return;
    return this.run(() => this.issueService.deleteSubtask(this.pid(), this.issue().id, s, this.myUid, this.tz()));
  }

  /** 並べ替え：動かした1件の order を、新しい位置の前後の真ん中の数にする */
  onDrop(e: CdkDragDrop<Subtask[], Subtask[], Subtask>) {
    if (e.previousIndex === e.currentIndex) return;
    const rest = this.list().filter((s) => s.id !== e.item.data.id);
    const before = rest[e.currentIndex - 1]?.order;
    const after = rest[e.currentIndex]?.order;
    const order = before === undefined ? (after ?? 0) - 1
      : after === undefined ? before + 1
        : (before + after) / 2;
    // 見張りの知らせを待たずに並びを変えておく（指を離した瞬間に元の位置へ跳ね返らないように）
    this.list.set([...rest.slice(0, e.currentIndex), { ...e.item.data, order }, ...rest.slice(e.currentIndex)]);
    return this.run(() => this.issueService.moveSubtask(this.pid(), this.issue().id, e.item.data.id, order, this.myUid));
  }

  late(s: Subtask) {
    return s.status !== 'done' && !!s.dueAt && s.dueAt.toMillis() < this.clock.now();
  }
  /** 親の期限があとで早まって、はみ出したもの（赤A：親の保存は止めず、ここで知らせる） */
  beyond(s: Subtask) {
    return s.status !== 'done' && !!s.dueAt && s.dueAt.toMillis() > this.issue().dueAt.toMillis();
  }
  dueText(s: Subtask) {
    return shortDue(s.dueAt!.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }

  private async run(op: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await op();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}