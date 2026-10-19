import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { IssueService } from '../../core/issue/issue.service';
import { SearchService } from '../../core/search/search.service';
import { normalize } from '../../core/search/match';
import { Member } from '../../core/models';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 候補の1行。insert＝選んだときに本文へ入れる文字 */
interface Cand { key: string; label: string; sub: string; insert: string; uid?: string; }

/**
 * コメント欄。「@」でメンバー、「#」でこのプロジェクトの課題の候補を出す。
 * メンションになるのは、候補から選んだ人だけ（同じ名前の人がいても、選んだ人に届くように）
 */
@Component({
  selector: 'app-comment-box',
  imports: [FormsModule, TPipe],
  template: `
    <div class="box">
      <textarea #ta [(ngModel)]="body" rows="3" [placeholder]="'detail.commentPlaceholder' | t"
        [attr.aria-label]="'detail.commentPlaceholder' | t" role="combobox" aria-controls="cb-list"
        [attr.aria-expanded]="cands().length > 0" [attr.aria-activedescendant]="cands().length ? 'cb-' + active() : null"
        (input)="detect()" (click)="detect()" (keydown)="onKey($event)" (focus)="search.load()"
        (blur)="trigger.set(null)"></textarea>
      @if (cands().length) {
        <ul class="cands" id="cb-list" role="listbox">
          @for (c of cands(); track c.key; let i = $index) {
            <li role="option" [id]="'cb-' + i" [attr.aria-selected]="i === active()" [class.on]="i === active()"
              (mousedown)="$event.preventDefault(); pick(c)" (mouseenter)="active.set(i)">
              <span class="label">{{ c.label }}</span><span class="sub">{{ c.sub }}</span>
            </li>
          }
        </ul>
      } @else if (trigger() === '#') {
        <p class="cands hint">{{ 'comment.hashHint' | t }}</p>
      }
    </div>
    <div class="foot">
      <p class="help">{{ 'comment.help' | t }}</p>
      <button type="button" class="primary" [disabled]="busy() || !body.trim()" (click)="send()">
        {{ 'detail.send' | t }}</button>
    </div>
    @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
  `,
  styles: `
    :host { display: block; margin-top: 12px; }
    .box { position: relative; }
    textarea { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px 12px; }
    .cands { position: absolute; left: 0; top: calc(100% + 2px); z-index: 40; width: min(360px, 100%); margin: 0;
      padding: 4px 0; list-style: none; background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15); max-height: 260px; overflow: auto; }
    .cands li { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; cursor: pointer; }
    .cands li.on { background: var(--surface-alt); }
    .label { font-weight: bold; white-space: nowrap; }
    .sub { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { padding: 8px 12px; font-size: 12px; color: var(--text-muted); }
    .foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
    .help { margin: 0; font-size: 12px; color: var(--text-muted); }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; flex: none; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); font-size: 13px; }
  `,
})
export class CommentBox {
  pid = input.required<string>();
  iid = input.required<string>();
  /** メンションできる人（閲覧者も含むメンバー全員・赤X） */
  members = input.required<Member[]>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  protected search = inject(SearchService);
  private readonly myUid = auth.currentUser!.uid;
  private ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

  body = '';
  busy = signal(false);
  error = signal('');
  /** 今、候補を出しているか（'@'＝メンバー、'#'＝課題、null＝出さない） */
  trigger = signal<'@' | '#' | null>(null);
  /** 「@」「#」のあとに打った文字 */
  private query = signal('');
  active = signal(0);
  /** 「@」「#」の位置（選んだときに、そこから置き換える） */
  private start = 0;
  /** 候補から選んだ人（名前 → uid）。送るときに、本文に「@名前」が残っている人だけをメンションにする */
  private picked = new Map<string, string>();
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  cands = computed<Cand[]>(() => {
    const q = normalize(this.query());
    if (this.trigger() === '@') {
      return this.members()
        .filter((m) => m.uid !== this.myUid && normalize(m.displayName).includes(q))
        .slice(0, 8)
        .map((m) => ({ key: m.uid, label: m.displayName, sub: this.i18n.t('roles.' + m.role),
          insert: '@' + m.displayName + ' ', uid: m.uid }));
    }
    if (this.trigger() === '#' && q) {
      // ヘッダーの検索の取り置きを使い回す（このプロジェクトだけ・赤W）
      const g = this.search.find(q, this.pid())[0];
      return (g?.results ?? [])
        .filter((r) => r.issue.id !== this.iid())
        .slice(0, 8)
        .map((r) => ({ key: r.issue.id, label: '#' + r.issue.number, sub: r.issue.title,
          insert: '#' + r.issue.number + ' ' }));
    }
    return [];
  });

  /**
   * カーソルの直前が「@名前の途中」「#番号の途中」かを見る。
   * 前が空白か先頭のときだけ（メールアドレスの「a@b」で候補を出さないため）。全角の＠・＃も受ける（日本語入力のまま打てるように）
   */
  detect() {
    const el = this.ta()!.nativeElement;
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = before.match(/(?:^|[\s　])([@＠#＃])([^\s　@＠#＃]{0,30})$/);
    if (!m) {
      this.trigger.set(null);
      return;
    }
    this.trigger.set(m[1] === '@' || m[1] === '＠' ? '@' : '#');
    this.query.set(m[2]);
    this.start = before.length - m[2].length - 1;
    this.active.set(0);
  }

  /** 候補が出ている間だけ、↑↓・Enter・Tab・Esc を候補に使う（日本語の変換中は何もしない） */
  onKey(e: KeyboardEvent) {
    const n = this.cands().length;
    if (!n || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.set((this.active() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      this.pick(this.cands()[this.active()]);
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // 詳細画面の Esc（開いている欄を閉じる）まで届かせない
      this.trigger.set(null);
    }
  }

  /** 「@途中」「#途中」を、選んだもので置き換え、カーソルをそのうしろへ */
  pick(c: Cand) {
    const el = this.ta()!.nativeElement;
    const caret = el.selectionStart ?? this.body.length;
    this.body = this.body.slice(0, this.start) + c.insert + this.body.slice(caret);
    if (c.uid) this.picked.set(c.label, c.uid);
    this.trigger.set(null);
    const at = this.start + c.insert.length;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  async send() {
    const body = this.body.trim();
    if (!body || this.busy()) return;
    // 選んだ人のうち、送る時点で本文に「@名前」が残っている人だけ（あとで消した人には届けない）
    const mentions = [...new Set([...this.picked]
      .filter(([name]) => body.includes('@' + name))
      .map(([, uid]) => uid))].slice(0, 20);
    this.busy.set(true);
    this.error.set('');
    try {
      await this.issueService.addComment(this.pid(), this.iid(), body, this.myUid, this.tz(), mentions);
      this.body = '';
      this.picked.clear();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}