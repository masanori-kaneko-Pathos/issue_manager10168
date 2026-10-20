import { Component, ElementRef, OnInit, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { IssueService } from '../../core/issue/issue.service';
import { SearchService } from '../../core/search/search.service';
import { normalize } from '../../core/search/match';
import { Member } from '../../core/models';
import { I18nService, TPipe } from '../../i18n/i18n';
import { AttachmentService, checkFile } from '../../core/attachment/attachment.service';
import { DraftService, fieldPlace } from '../../core/draft/draft.service';

/** 1つのコメントに添付できる数 */
const MAX_COMMENT_FILES = 5;

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
        (input)="detect(); stash()" (click)="detect()" (keydown)="onKey($event)" (focus)="search.load()"
        (blur)="trigger.set(null)" (paste)="onPaste($event)" (dragover)="onDragOver($event)"
        (dragleave)="over.set(false)" (drop)="onDrop($event)" [class.over]="over()"></textarea>
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
    @if (pending().length) {
      <ul class="pending">
        @for (f of pending(); track $index) {
          <li>
            <span class="pname">{{ f.file.name }}</span>
            @if (f.p !== null) {
              <span class="bar"><span class="fill" [style.width.%]="f.p * 100"></span></span>
            } @else {
              <button type="button" class="x" [attr.aria-label]="'attach.unpick' | t: { name: f.file.name }"
                (click)="unpick($index)">✕</button>
            }
          </li>
        }
      </ul>
    }
    @for (e of fileErrors(); track $index) { <p class="error" role="alert">{{ e.key | t: { name: e.name, n: '' + max } }}</p> }
    <div class="foot">
      <label class="clip" [title]="'attach.addToComment' | t" [attr.aria-label]="'attach.addToComment' | t">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" /></svg>
        <input type="file" multiple hidden (change)="onPick($event)" />
      </label>
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
    textarea.over { outline: 2px dashed var(--primary); outline-offset: 2px; }
    .pending { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .pending li { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px;
      background: var(--surface-alt); font-size: 13px; }
    .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar { flex: 0 0 80px; height: 4px; border-radius: 2px; background: var(--surface-muted); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--primary); }
    .x { width: 28px; height: 28px; border: none; background: none; color: var(--text-muted); cursor: pointer; }
    .clip { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 8px; color: var(--text-muted); cursor: pointer; }
    .clip:hover { background: var(--surface-alt); color: var(--text); }
  `,
})
export class CommentBox implements OnInit {
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
  private files = inject(AttachmentService);
  readonly max = MAX_COMMENT_FILES;
  /** 送信まで手元にためるファイル（p＝上げている途中の進み具合。上げる前は null） */
  pending = signal<{ file: File; p: number | null }[]>([]);
  fileErrors = signal<{ key: string; name: string }[]>([]);
  over = signal(false);

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

  private drafts = inject(DraftService);
  private place = computed(() => fieldPlace(this.pid(), this.iid(), 'comment'));

  ngOnInit() {
    this.body = this.drafts.getText(this.place());
  }

  /** 打つたびにしまう。同じ (input) の中でまだ body が入れ替わっていないこともあるので、欄の文字を直接読む */
  stash() {
    this.drafts.setText(this.place(), this.ta()?.nativeElement.value ?? this.body);
  }


  // ---- 添付（送信まで手元にためる） ----
  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const list = Array.from(input.files ?? []);
    input.value = '';
    this.addFiles(list);
  }

  /** 画像を貼り付けたら、添付として受け取る（文字の貼り付けは、そのまま本文へ） */
  onPaste(e: ClipboardEvent) {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (!list.length) return;
    e.preventDefault();
    this.addFiles(list);
  }

  onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return; // 文字のドラッグは、ふつうに本文へ
    e.preventDefault();
    this.over.set(true);
  }

  onDrop(e: DragEvent) {
    const list = Array.from(e.dataTransfer?.files ?? []);
    this.over.set(false);
    if (!list.length) return;
    e.preventDefault();
    this.addFiles(list);
  }

  private addFiles(list: File[]) {
    this.fileErrors.set([]);
    for (const f of list) {
      if (this.pending().length >= MAX_COMMENT_FILES) {
        this.fileErrors.update((x) => [...x, { key: 'attach.commentMax', name: f.name }]);
        break;
      }
      const bad = checkFile(f);
      if (bad) this.fileErrors.update((x) => [...x, { key: 'attach.' + bad, name: f.name }]);
      else this.pending.update((p) => [...p, { file: f, p: null }]);
    }
  }

  unpick(i: number) {
    this.pending.update((p) => p.filter((_, j) => j !== i));
  }

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
    this.stash();
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
      const cid = await this.issueService.addComment(this.pid(), this.iid(), body, this.myUid, this.tz(), mentions);
      this.body = '';
      this.picked.clear();
      this.drafts.clearText(this.place());
      // コメントができたら、ためておいたファイルを、そのコメントの下に上げる（同時に進む）
      const list = this.pending();
      if (list.length) {
        this.pending.set(list.map((x) => ({ ...x, p: 0 })));
        const results = await Promise.allSettled(list.map((x, i) => this.files.upload(
          this.pid(), this.iid(), x.file, this.myUid, this.tz(), {
            cid,
            onProgress: (p) => this.pending.update((all) => all.map((y, j) => (j === i ? { ...y, p } : y))),
          })));
        this.fileErrors.set(results.flatMap((r, i) => r.status === 'rejected'
          ? [{ key: (r.reason as Error)?.message === 'tooBig' ? 'attach.tooBig' : 'attach.failed', name: list[i].file.name }]
          : []));
        this.pending.set([]);
      }
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}