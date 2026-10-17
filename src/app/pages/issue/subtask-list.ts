import { Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { Unsubscribe } from 'firebase/firestore';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { IssueService, SubtaskEdits } from '../../core/issue/issue.service';
import { Issue, MAX_SUBTASKS, Member, Subtask } from '../../core/models';
import { dateKey, shortDue, zonedTime } from '../../core/time/time';
import { enterKey } from '../../core/dom';
import { MemberSelect } from '../../shared/member-select';
import { HelpTip } from '../../shared/help-tip';
import { I18nService, TPipe } from '../../i18n/i18n';

/**
 * 課題の詳細の「サブタスク」の欄。見張り・追加・□・行の編集・並べ替えを、この中で済ませる。
 * 詳細画面は「どこに置くか」と「だれが何をできるか」だけを渡す
 */
@Component({
  selector: 'app-subtask-list',
  imports: [FormsModule, RouterLink, CdkDropList, CdkDrag, CdkDragHandle, MemberSelect, HelpTip, TPipe],
  host: { '(document:keydown.escape)': 'menuFor.set(null); editing.set(null)' },
  template: `
    <div class="head">
      @if (counted().length) {
        <span class="count">{{ 'subtask.progress' | t: { done: '' + doneCount(), total: '' + counted().length } }}</span>
        <span class="bar" role="progressbar" aria-valuemin="0" [attr.aria-valuemax]="counted().length"
          [attr.aria-valuenow]="doneCount()"><span class="fill" [style.width.%]="pct()"></span></span>
      }
      <app-help-tip [keys]="['subtask.help']" />
    </div>

    <ul class="list" cdkDropList [cdkDropListData]="list()" [cdkDropListDisabled]="!canEdit() || !!editing()"
      (cdkDropListDropped)="onDrop($event)">
      @for (s of list(); track s.id) {
        <li class="row" cdkDrag [cdkDragData]="s" [class.split]="!!s.splitTo" [class.done]="s.status === 'done'">
          @if (editing() === s.id) {
            <div class="edit">
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
              <span class="title">{{ s.title }}</span>
              @if (s.splitTo; as sp) {
                <a class="to" [routerLink]="['/p', pid(), 'i', sp.iid]">{{ 'subtask.splitTo' | t: { n: '' + sp.number } }}</a>
              }
              @if (s.memo) { <span class="memo">{{ s.memo }}</span> }
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
                  <div class="menu" role="menu">
                    @if (canToggle(s) && s.status !== 'done') {
                      <button type="button" role="menuitem" (click)="toggleDoing(s)">
                        {{ (s.status === 'doing' ? 'subtask.toTodo' : 'subtask.toDoing') | t }}</button>
                    }
                    @if (canEdit()) {
                      <button type="button" role="menuitem" (click)="startEdit(s)">{{ 'subtask.edit' | t }}</button>
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
      } @else {
        <div class="add">
          <input [(ngModel)]="newTitle" maxlength="200" [placeholder]="'subtask.add' | t"
            [attr.aria-label]="'subtask.name' | t" [disabled]="busy()" (keydown)="onAddKey($event)" />
          <button type="button" class="add-btn" [disabled]="busy() || !newTitle.trim()" (click)="add()">
            {{ 'subtask.addBtn' | t }}</button>
        </div>
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
    .list { list-style: none; margin: 4px 0 0; padding: 0; }
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
    .more-wrap { position: relative; }
    .more { width: 32px; height: 32px; border: none; background: none; border-radius: 6px; color: var(--text-muted);
      cursor: pointer; }
    .more:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 180px; background: var(--surface);
      border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); padding: 6px 0; display: flex; flex-direction: column; }
    .menu button { text-align: left; padding: 0 16px; min-height: 40px; background: none; border: none; color: var(--text);
      font-size: 14px; cursor: pointer; }
    .menu button:hover { background: var(--surface-alt); }
    .menu .danger { color: var(--danger-text); }
    .edit { flex: 1; display: flex; flex-direction: column; gap: 8px; }
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

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;
  private stop: Unsubscribe | null = null;
  readonly max = MAX_SUBTASKS;

  list = signal<Subtask[]>([]);
  menuFor = signal<string | null>(null);
  editing = signal<string | null>(null);
  busy = signal(false);
  error = signal('');
  newTitle = '';
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
    inject(DestroyRef).onDestroy(() => this.stop?.());
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

  onAddKey(e: KeyboardEvent) {
    enterKey(e, () => this.add());
  }

  /** タイトルだけで足す。担当者は親の担当者（いなければ自分）、期限は空、並びは一番下 */
  add() {
    const title = this.newTitle.trim();
    if (!title || this.full() || this.busy()) return;
    const i = this.issue();
    const assigneeId = this.members().some((m) => m.uid === i.assigneeId) ? i.assigneeId : this.myUid;
    const order = (this.list().at(-1)?.order ?? 0) + 1;
    return this.run(async () => {
      await this.issueService.addSubtask(this.pid(), i, { title, assigneeId, dueAt: null, order },
        this.myUid, this.tz());
      this.newTitle = '';
    });
  }

  startEdit(s: Subtask) {
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
      this.editing.set(null);
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