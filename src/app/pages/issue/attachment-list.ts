import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ImageViewer, ViewerImage } from '../../shared/image-viewer';
import { TextView, TextViewer } from '../../shared/text-viewer';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { AttachmentService, checkFile } from '../../core/attachment/attachment.service';
import { Attachment, MAX_ATTACHMENTS } from '../../core/models';
import { formatDateTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 大きさを「1.2 MB」「340 KB」のように */
export function sizeText(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 課題の「添付」の欄：一覧・追加（ボタンとドラッグ）・進み具合・削除 */
@Component({
  selector: 'app-attachment-list',
  imports: [TPipe, ImageViewer, TextViewer],
  template: `
    <div class="drop" [class.over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)"
      (drop)="onDrop($event)">
      @if (items().length || uploading().length) {
        <ul class="files">
          @for (a of items(); track a.id) {
            <li>
              @if (isImage(a) && urls()[a.id] && !broken().has(a.id)) {
                <button type="button" class="thumb" [attr.aria-label]="'attach.view' | t: { name: a.name }" (click)="open(a)">
                  <img [src]="urls()[a.id]" alt="" loading="lazy" (error)="markBroken(a.id)" />
                </button>
              } @else {
                <svg class="ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  @if (a.type.startsWith('image/')) {
                    <rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" />
                  } @else {
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" />
                  }
                </svg>
              }
              <div class="body">
                <button type="button" class="name" [title]="(kindOf(a) === 'file' ? 'attach.download' : 'attach.open') | t: { name: a.name }"
                  (click)="open(a)">{{ a.name }}
                  @if (kindOf(a) === 'file') {
                    <svg class="dl" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor"
                      stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
                  }</button>
                <span class="meta">{{ size(a.size) }} · {{ nameOf()(a.by) }} · {{ when(a) }}</span>
              </div>
              @if (canRemove(a)) {
                <button type="button" class="del" [title]="'attach.delete' | t" [attr.aria-label]="'attach.delete' | t"
                  (click)="remove(a)">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
                </button>
              }
            </li>
          }
          @for (u of uploading(); track u.id) {
            <li class="up">
              <div class="body">
                <span class="name-plain">{{ u.name }}</span>
                <span class="bar"><span class="fill" [style.width.%]="u.p * 100"></span></span>
              </div>
            </li>
          }
        </ul>
      }
      @if (canAdd()) {
        @if (items().length + uploading().length < max) {
          <div class="add-row">
            <label class="add">{{ 'attach.add' | t }}
              <input type="file" multiple hidden (change)="onPick($event)" />
            </label>
            <span class="hint">{{ 'attach.dropHint' | t }}</span>
          </div>
        } @else {
          <p class="hint">{{ 'attach.max' | t: { n: '' + max } }}</p>
        }
      }
      @for (e of errors(); track $index) { <p class="error" role="alert">{{ e.key | t: { name: e.name } }}</p> }
    </div>
    @if (viewer(); as v) {
      <app-image-viewer [images]="v.list" [start]="v.index" (close)="viewer.set(null)" />
    }
    @if (textView(); as tv) {
      <app-text-viewer [view]="tv" (close)="textView.set(null)" />
    }
  `,
  styles: `
    :host { display: block; }
    .drop { border-radius: 8px; }
    .drop.over { outline: 2px dashed var(--primary); outline-offset: 4px; background: var(--primary-bg); }
    .files { list-style: none; margin: 0; padding: 0; }
    .files li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .ic { flex: none; color: var(--text-muted); }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .name { align-self: flex-start; max-width: 100%; padding: 0; border: none; background: none; color: var(--primary);
      font: inherit; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
    .name:hover { text-decoration: underline; }
    .name-plain { overflow-wrap: anywhere; color: var(--text-muted); }
    .meta { font-size: 12px; color: var(--text-muted); }
    .bar { display: block; height: 4px; border-radius: 2px; background: var(--surface-muted); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--primary); transition: width 0.2s; }
    .del { flex: none; width: 32px; height: 32px; border: none; border-radius: 6px; background: none;
      color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .del:hover { background: var(--surface-muted); color: var(--danger-text); }
    .add-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 6px; }
    .add { display: inline-flex; align-items: center; min-height: 36px; color: var(--primary); font-size: 14px; cursor: pointer; }
    .hint { font-size: 12px; color: var(--text-muted); margin: 0; }
    .error { margin: 4px 0 0; font-size: 13px; color: var(--danger-text); }
    .thumb { flex: none; width: 56px; height: 56px; padding: 0; border: 1px solid var(--border); border-radius: 6px;
      overflow: hidden; background: var(--surface-alt); cursor: zoom-in; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb:hover { border-color: var(--primary); }
    .dl { vertical-align: -2px; margin-left: 4px; }
  `,
})
export class AttachmentList {
  pid = input.required<string>();
  /** 課題の id。プロジェクトの概要の添付のときは null */
  iid = input.required<string | null>();
  /** 添付できる数（課題は10、プロジェクトの概要は20） */
  limit = input(MAX_ATTACHMENTS);
  /** この課題への添付（コメントへの添付は含まない） */
  items = input<Attachment[]>([]);
  /** 足せるか（管理者・メンバーで、課題がまだ動いている） */
  canAdd = input(false);
  /** 管理者か（ほかの人の添付も消せる） */
  isAdmin = input(false);
  /** アーカイブ中（だれも消せない） */
  archived = input(false);
  nameOf = input.required<(uid: string) => string>();

  private files = inject(AttachmentService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private readonly myUid = auth.currentUser!.uid;
  get max() {
    return this.limit();
  }
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  over = signal(false);
  uploading = signal<{ id: number; name: string; p: number }[]>([]);
  errors = signal<{ key: string; name: string }[]>([]);
  private seq = 0;

  // ---- 小さな絵と、大きく見る窓 ----
  /** 画像の URL（添付の id → URL）。倉庫から1回だけもらう */
  urls = signal<Record<string, string>>({});
  /** もう URL を頼んだ添付（同じものを何度も頼まないための控え。画面に出さないのでシグナルにしない） */
  private asked = new Set<string>();
  /** この端末で表示できない画像（iPhone の HEIC を Chrome で見たときなど）。アイコンに戻す */
  broken = signal(new Set<string>());
  /** 大きく見ている画像（null＝閉じている） */
  viewer = signal<{ list: ViewerImage[]; index: number } | null>(null);

  constructor() {
    // 画像の添付が増えたら、その URL をもらう（もらった分は控えておき、二度は頼まない）
    effect(() => {
      for (const a of this.items()) {
        if (!this.isImage(a) || this.asked.has(a.id)) continue;
        this.asked.add(a.id);
        this.files.urlOf(a)
          .then((u) => this.urls.update((m) => ({ ...m, [a.id]: u })))
          .catch((e) => console.warn('画像の URL をもらえませんでした', a.name, e));
      }
    });
  }

  /** 見ている CSV・テキスト（null＝閉じている） */
  textView = signal<TextView | null>(null);

  /**
   * 押したときの扱い：image＝大きく見る、table＝表で見る、text＝テキストで見る、pdf＝新しいタブ、
   * file＝ダウンロード（Excel・Word などは、ブラウザが表示できずにダウンロードに回すため、そうと書いて落とす）
   */
  kindOf(a: Attachment): 'image' | 'table' | 'text' | 'pdf' | 'file' {
    if (this.isImage(a)) return 'image';
    if (a.type === 'text/csv' || /\.(csv|tsv)$/i.test(a.name)) return 'table';
    if (a.type === 'text/plain') return 'text';
    if (a.type === 'application/pdf') return 'pdf';
    return 'file';
  }

  /** CSV は表に、テキストはそのまま。長いものは、はじめの500行（テキストは20万字）だけ */
  private async showText(a: Attachment, table: boolean) {
    this.textView.set({ name: a.name, loading: true });
    try {
      const raw = await this.files.textOf(a);
      if (table) {
        const { parseDelimited, looksTabbed } = await import('../../core/import/parse');
        const all = parseDelimited(raw, /\.tsv$/i.test(a.name) || looksTabbed(raw) ? '\t' : ',');
        this.textView.set({ name: a.name, loading: false, rows: all.slice(0, 501), more: Math.max(0, all.length - 501) });
      } else {
        this.textView.set({ name: a.name, loading: false, text: raw.slice(0, 200000) });
      }
    } catch (e) {
      console.error(e);
      this.textView.set({ name: a.name, loading: false, failed: true });
    }
  }

  /** ダウンロード：この画面のまま落とす（新しいタブにすると、空のタブが残るため） */
  private async download(a: Attachment) {
    try {
      const url = await this.files.urlOf(a);
      const link = document.createElement('a');
      link.href = url;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.error(e);
      this.errors.set([{ key: 'attach.openFailed', name: a.name }]);
    }
  }

  isImage(a: Attachment) {
    return a.type.startsWith('image/');
  }

  markBroken(id: string) {
    this.broken.update((s) => new Set(s).add(id));
  }

  canRemove(a: Attachment) {
    return !this.archived() && (a.by === this.myUid || this.isAdmin());
  }

  size(n: number) {
    return sizeText(n);
  }

  when(a: Attachment) {
    return formatDateTime(a.at.toDate(), this.tz(), this.i18n.lang());
  }

  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const list = Array.from(input.files ?? []);
    input.value = ''; // 同じファイルをもう一度選んでも、選んだことになるように
    this.addFiles(list);
  }

  onDragOver(e: DragEvent) {
    if (!this.canAdd()) return;
    e.preventDefault(); // これがないと、落とせない（ブラウザがファイルを開いてしまう）
    this.over.set(true);
  }

  onDrop(e: DragEvent) {
    if (!this.canAdd()) return;
    e.preventDefault();
    this.over.set(false);
    this.addFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  /** 数・大きさ・種類を確かめてから、1つずつ上げる（同時に進む） */
  private addFiles(list: File[]) {
    this.errors.set([]);
    for (const f of list) {
      if (this.items().length + this.uploading().length >= this.max) {
        this.errors.update((e) => [...e, { key: 'attach.max', name: f.name }]);
        break;
      }
      const bad = checkFile(f);
      if (bad) {
        this.errors.update((e) => [...e, { key: 'attach.' + bad, name: f.name }]);
        continue;
      }
      this.start(f);
    }
  }

  private async start(f: File) {
    const id = ++this.seq;
    this.uploading.update((u) => [...u, { id, name: f.name, p: 0 }]);
    try {
      await this.files.upload(this.pid(), this.iid(), f, this.myUid, this.tz(), {
        onProgress: (p) => this.uploading.update((u) => u.map((x) => (x.id === id ? { ...x, p } : x))),
      });
    } catch (e) {
        console.error(e);
        const key = (e as Error).message === 'tooBig' ? 'attach.tooBig' : 'attach.failed';
        this.errors.update((x) => [...x, { key, name: f.name }]);
    } finally {
      this.uploading.update((u) => u.filter((x) => x.id !== id));
    }
  }

  /**
   * 新しいタブで開く。先にタブを開いておき、URL が届いたら中身を入れる
   * （URL を待ってから開くと、ブラウザに「勝手に開いたタブ」として止められるため）
   */
  async open(a: Attachment) {
    const kind = this.kindOf(a);
    if (kind === 'table' || kind === 'text') return this.showText(a, kind === 'table');
    if (kind === 'file') return this.download(a);
    // 画像は、その場で大きく見る（この欄の画像を ← → で次々見られるように）
    if (this.isImage(a) && !this.broken().has(a.id)) {
      try {
        const url = this.urls()[a.id] ?? (await this.files.urlOf(a));
        const list = this.items()
          .filter((x) => this.isImage(x) && !this.broken().has(x.id))
          .map((x) => ({ id: x.id, name: x.name, url: x.id === a.id ? url : this.urls()[x.id] ?? '' }))
          .filter((x) => x.url);
        this.viewer.set({ list, index: Math.max(0, list.findIndex((x) => x.id === a.id)) });
      } catch (e) {
        console.error(e);
        this.errors.set([{ key: 'attach.openFailed', name: a.name }]);
      }
      return;
    }
    const w = window.open('', '_blank');
    try {
      const url = await this.files.urlOf(a);
      if (w) w.location.href = url;
      else location.href = url;
    } catch (e) {
      console.error(e);
      w?.close();
      this.errors.set([{ key: 'attach.openFailed', name: a.name }]);
    }
  }

  /** ファイルは戻せないので、確かめてから */
  async remove(a: Attachment) {
    if (!confirm(this.i18n.t('attach.deleteConfirm', { name: a.name }))) return;
    try {
      await this.files.remove(this.pid(), this.iid(), a, this.myUid, this.tz());
    } catch (e) {
      console.error(e);
      this.errors.set([{ key: 'attach.deleteFailed', name: a.name }]);
    }
  }
}