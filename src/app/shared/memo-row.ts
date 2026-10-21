import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { InboxService, joinMemo, splitMemo } from '../core/inbox/inbox.service';
import { UndoService } from '../core/undo/undo.service';
import { Clock } from '../core/time/clock';
import { InboxMemo } from '../core/models';
import { IS_TOUCH, enterKey } from '../core/dom';
import { relativeTime } from '../core/time/time';
import { I18nService, TPipe } from '../i18n/i18n';
import { IssueFormService } from '../core/issue/issue-form.service';

/**
 * 受信箱のメモの1行。押すか ✎ で、その場で直せる（1行目がタイトル、2行目から詳しいこと）。
 * Enter か外を押すと保存、Esc で直さずに戻す。PC は乗せるとアイコン、スマホは ⋮（吹き出し）か、いつもアイコン（ページ）
 */
@Component({
  selector: 'app-memo-row',
  imports: [FormsModule, TPipe],
  host: { '[class.compact]': 'compact()' },
  template: `
    @if (editing()) {
      <div class="edit">
        <textarea [id]="'memo-edit-' + memo().id" [ngModel]="text()" (ngModelChange)="text.set($event)"
          [rows]="compact() ? 3 : 4" maxlength="5200" [attr.aria-label]="'inbox.edit' | t"
          (keydown)="onKey($event)" (blur)="save()"></textarea>
        <p class="help">{{ (touch ? 'inbox.editHelpTouch' : 'inbox.editHelp') | t }}</p>
        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      </div>
    } @else {
      <div class="row">
        <button type="button" class="main" [title]="'inbox.edit' | t" (click)="startEdit()">
          <span class="t">@if (memo().pinned) {<svg class="pin-mark" viewBox="0 0 24 24" width="12" height="12" role="img" [attr.aria-label]="'notify.pinned' | t" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>}{{ memo().title }}</span>
          @if (memo().body) { <span class="b">{{ firstLine(memo().body) }}</span> }
          @if (!compact()) {
            <span class="meta">{{ edited() ? ('inbox.editedAgo' | t: { t: when() }) : when() }}
              @if (inbox.isOld(memo())) { <span class="old">{{ 'inbox.old' | t }}</span> }</span>
          }
        </button>

        @if (touch && touchUi() === 'menu') {
          <button type="button" class="more" [attr.aria-label]="'inbox.memoMenu' | t" [attr.aria-expanded]="menuOpen()"
            (click)="toggleMenu($event)">⋮</button>
          @if (menuOpen()) {
            <div class="m-backdrop" (click)="menuOpen.set(false)"></div>
            <div class="m-menu" role="menu" [class.left]="menuLeft()">
              <button type="button" role="menuitem" (click)="toIssue()">{{ 'inbox.toIssue' | t }}</button>
              <button type="button" role="menuitem" (click)="togglePin()">
                {{ (memo().pinned ? 'inbox.unpin' : 'inbox.pin') | t }}</button>
              <button type="button" role="menuitem" (click)="startEdit()">{{ 'inbox.edit' | t }}</button>
              <button type="button" role="menuitem" class="danger" (click)="remove()">{{ 'inbox.popDelete' | t }}</button>
            </div>
          }
        } @else {
          <div class="acts" [class.always]="touch" role="group" [attr.aria-label]="'inbox.memoMenu' | t">
            <button type="button" class="ic" [class.on]="!!memo().pinned" [attr.aria-pressed]="!!memo().pinned"
              [title]="(memo().pinned ? 'inbox.unpin' : 'inbox.pin') | t"
              [attr.aria-label]="(memo().pinned ? 'inbox.unpin' : 'inbox.pin') | t" (click)="togglePin()">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" [attr.fill]="memo().pinned ? 'currentColor' : 'none'"
                stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>
            </button>
            <button type="button" class="ic" [title]="'inbox.toIssue' | t" [attr.aria-label]="'inbox.toIssue' | t" (click)="toIssue()">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" class="ic danger" [title]="'inbox.popDelete' | t" [attr.aria-label]="'inbox.popDelete' | t"
              (click)="remove()">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; flex: 1; width: 100%; min-width: 0; }
    .row { position: relative; display: flex; align-items: center; gap: 4px; border-radius: 6px; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px 6px; border: none;
      background: none; color: var(--text); text-align: left; font: inherit; cursor: pointer; }
    .t { font-size: 15px; overflow-wrap: anywhere; }
    .b { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { font-size: 12px; color: var(--text-muted); }
    .old { margin-left: 6px; font-size: 11px; padding: 1px 8px; border-radius: 10px;
      background: var(--warning-bg); color: var(--warning-text); }
    /* 吹き出しの中：1行に、タイトルと詳しいことを15文字ほどで切って並べる */
    :host(.compact) .main { flex-direction: row; align-items: baseline; gap: 10px; padding: 4px 6px; min-height: 30px; }
    :host(.compact) .t { flex: none; max-width: 15em; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    :host(.compact) .b { min-width: 0; max-width: 15em; font-size: 11px; color: var(--text-muted); }
    .acts { display: none; gap: 2px; }
    .acts.always { display: flex; flex: none; }
    .ic { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border: none; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
    .ic:hover { background: var(--surface-muted); color: var(--text); }
    .ic.danger:hover { color: var(--danger-text); }
    .ic.on { color: var(--primary); }
    .pin-mark { vertical-align: -1px; margin-right: 4px; color: var(--primary); }
    @media (hover: hover) and (pointer: fine) {
      .row:hover { background: var(--surface-alt); }
      .row:hover .acts, .row:focus-within .acts { display: flex; position: absolute; right: 4px; top: 50%;
        transform: translateY(-50%); padding: 2px; border-radius: 8px; background: var(--surface-alt); }
    }
    .more { flex: none; width: 32px; height: 32px; border: none; border-radius: 6px; background: none;
      color: var(--text-muted); font-size: 16px; cursor: pointer; }
    .m-backdrop { position: fixed; inset: 0; z-index: 1; }
    .m-menu { position: absolute; top: 0; left: calc(100% + 4px); z-index: 2; min-width: 130px; padding: 6px 0;
      display: flex; flex-direction: column; background: var(--surface); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .m-menu.left { left: auto; right: 36px; }
    .m-menu button { text-align: left; padding: 0 16px; min-height: 38px; background: none; border: none;
      color: var(--text); font-size: 13px; cursor: pointer; }
    .m-menu .danger { color: var(--danger-text); }
    .edit { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
    .edit textarea { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px 10px; border-radius: 8px; }
    .help { margin: 0; font-size: 11px; color: var(--text-muted); }
    .error { margin: 0; color: var(--danger-text); font-size: 13px; }
  `,
})
export class MemoRow implements OnInit {
  memo = input.required<InboxMemo>();
  /** 吹き出しの中の、詰めた見た目 */
  compact = input(false);
  /** スマホでの操作の出し方：menu＝⋮（吹き出し）、icons＝いつもアイコン（ページ） */
  touchUi = input<'menu' | 'icons'>('icons');
  /** 最初から直す状態で出す（検索などから ?m= で来たとき） */
  startEditing = input(false);
  /** 直し終えた（保存できた）。受信箱のページと吹き出しが、少し待ってから上へ動かす */
  saved = output<void>();
  /** 別の画面へ移る（吹き出しを閉じるため） */
  leave = output<void>();

  protected inbox = inject(InboxService);
  private undo = inject(UndoService);
  private router = inject(Router);
  private issueForm = inject(IssueFormService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);
  readonly touch = IS_TOUCH;

  editing = signal(false);
  text = signal('');
  error = signal('');
  menuOpen = signal(false);
  menuLeft = signal(false);
  private busy = false;
  /** Esc で戻したとき、欄が消えるときの blur で保存しないための目印 */
  private cancelling = false;

  /** 書いたあとに直したか（書いたときは、作成と更新が同じ時刻） */
  edited = computed(() => !this.memo().updatedAt.isEqual(this.memo().createdAt));
  /** 並び（更新の新しい順）に合わせて、最後に直した時刻を出す */
  when = computed(() => relativeTime(this.memo().updatedAt.toMillis(), this.i18n.lang(), this.clock.now()));

  ngOnInit() {
    if (this.startEditing()) this.startEdit();
  }

  firstLine(body: string) {
    return body.split('\n')[0];
  }

  startEdit() {
    this.menuOpen.set(false);
    this.error.set('');
    this.text.set(joinMemo(this.memo()));
    this.editing.set(true);
    setTimeout(() => {
      const el = document.getElementById('memo-edit-' + this.memo().id) as HTMLTextAreaElement | null;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length); // 文の最後から書き足せるように
      el.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Esc＝直さずに戻す（吹き出しは閉じない）。Enter＝欄から外れて保存。Shift＋Enter・スマホの Enter＝改行 */
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation(); // ヘッダーの Esc（吹き出しを閉じる）まで届かせない
      this.cancelling = true;
      this.editing.set(false);
      return;
    }
    const next = enterKey(e, () => (e.target as HTMLElement).blur(), true);
    if (next !== null) this.text.set(next);
  }

  /** 外を押した・Enter で、保存する。変わっていなければ、保存せずに戻す。タイトルを空にしたら、直さずに戻す */
  async save() {
    if (this.cancelling) {
      this.cancelling = false;
      return;
    }
    if (!this.editing() || this.busy) return;
    const m = this.memo();
    const { title, body } = splitMemo(this.text());
    if (!title || (title === m.title && body === m.body)) {
      this.editing.set(false);
      return;
    }
    this.busy = true;
    try {
      await this.inbox.update(m.id, title, body);
      this.editing.set(false);
      this.saved.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy = false;
    }
  }

  toIssue() {
    this.menuOpen.set(false);
    this.leave.emit();
    this.issueForm.open(null, { memo: this.memo().id });
  }

  /** ピン止めの付け外し */
  async togglePin() {
    this.menuOpen.set(false);
    try {
      await this.inbox.setPinned(this.memo().id, !this.memo().pinned);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }

  /** ゴミ箱へ（30日で自動で消える）。下に「元に戻す」 */
  async remove() {
    this.menuOpen.set(false);
    const id = this.memo().id;
    try {
      await this.inbox.discard(id);
      this.undo.offer('inbox.discarded', undefined, () => this.inbox.restore(id));
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }

  toggleMenu(e: MouseEvent) {
    if (this.menuOpen()) {
      this.menuOpen.set(false);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuLeft.set(window.innerWidth - r.right < 140);
    this.menuOpen.set(true);
  }
}