import { Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { SavedFilter } from '../../core/models';
import { MAX_SAVED_FILTERS, SavedFilterService } from '../../core/filter/saved-filter.service';
import { TPipe } from '../../i18n/i18n';

/** 名前を比べる形（全角半角・大文字小文字をそろえる） */
const norm = (s: string) => s.trim().normalize('NFKC').toLowerCase();

/**
 * 保存した絞り込み（ボタン1つ ＋ 吹き出し）。押すと当てる・✕ で消す・一番下で今の条件を保存。
 * 条件そのものは外（リスト）が持ち、ここは applied で知らせるだけ
 */
@Component({
  selector: 'app-saved-filters',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <div class="wrap">
      <button type="button" class="trigger" [class.on]="!!active()" aria-haspopup="true"
        [attr.aria-expanded]="open()" (click)="toggle()">
        <span aria-hidden="true">★</span>
        <span class="text">{{ active()?.name || ('savedFilter.open' | t) }}</span>
        <span aria-hidden="true">▾</span>
      </button>
      @if (open()) {
        <div class="backdrop" (click)="close()"></div>
        <div class="pop" role="menu" animate.leave="im-out" animate.leave="im-out">
          <div class="rows">
            @for (f of list(); track f.id) {
              <div class="row">
                <button type="button" role="menuitem" class="pick" (click)="pick(f)">
                  <span class="check" aria-hidden="true">{{ f.id === active()?.id ? '✓' : '' }}</span>
                  <span class="name">{{ f.name }}</span>
                </button>
                <button type="button" class="x" [attr.aria-label]="'savedFilter.remove' | t: { name: f.name }"
                  (click)="remove(f)">✕</button>
              </div>
            } @empty {
              <p class="none">{{ 'savedFilter.none' | t }}</p>
            }
          </div>

          <div class="foot">
            @if (asking(); as f) {
              <p class="msg">{{ 'savedFilter.overwriteAsk' | t: { name: f.name } }}</p>
              <div class="btns">
                <button type="button" class="link" (click)="asking.set(null)">{{ 'savedFilter.cancel' | t }}</button>
                <button type="button" class="primary" [disabled]="busy()" (click)="overwrite()">
                  {{ 'savedFilter.overwrite' | t }}</button>
              </div>
            } @else if (naming()) {
              <input #nameInput type="text" class="name-input" maxlength="50"
                [placeholder]="'savedFilter.namePlaceholder' | t" [attr.aria-label]="'savedFilter.namePlaceholder' | t"
                [value]="name()" (input)="name.set($any($event.target).value)" (keydown.enter)="onEnter($event)" />
              @if (blockedByLimit()) {
                <p class="msg warn">{{ 'savedFilter.limit' | t: { n: '' + max } }}</p>
              }
              <div class="btns">
                <button type="button" class="link" (click)="naming.set(false)">{{ 'savedFilter.cancel' | t }}</button>
                <button type="button" class="primary" [disabled]="busy() || !name().trim() || blockedByLimit()"
                  (click)="save()">{{ 'savedFilter.save' | t }}</button>
              </div>
            } @else {
              <button type="button" class="add" [disabled]="!current()" (click)="startNaming()">
                {{ 'savedFilter.saveCurrent' | t }}</button>
              @if (!current()) {
                <p class="msg">{{ 'savedFilter.nothingToSave' | t }}</p>
              }
            }
            @if (error()) {
              <p class="msg warn" role="alert">{{ 'savedFilter.saveFailed' | t }}</p>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: inline-block; }
    .wrap { position: relative; }
    .trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px;
      border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
      border-radius: 18px; font-size: 13px; cursor: pointer; }
    .trigger.on { background: var(--primary-bg); border-color: var(--primary); color: var(--primary); }
    .text { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .pop { position: absolute; left: 0; top: calc(100% + 4px); z-index: 52; width: min(300px, calc(100vw - 32px));
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); padding: 6px 0; }
    .rows { max-height: min(320px, 50vh); overflow-y: auto; display: flex; flex-direction: column; }
    .row { flex: none; display: flex; align-items: center; }
    .row:hover { background: var(--surface-alt); }
    .pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 4px 0 12px;
      background: none; border: none; text-align: left; font-size: 14px; color: var(--text); cursor: pointer; }
    .check { width: 16px; flex: none; color: var(--primary); font-weight: bold; }
    .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .x { flex: none; width: 40px; min-height: 44px; background: none; border: none; color: var(--text-subtle); cursor: pointer; }
    .x:hover { color: var(--danger); }
    .none { margin: 8px 12px; font-size: 13px; color: var(--text-subtle); }
    .foot { border-top: 1px solid var(--border); margin-top: 4px; padding: 6px 8px 2px;
      display: flex; flex-direction: column; gap: 6px; }
    .add { min-height: 40px; background: none; border: none; text-align: left; padding: 0 4px;
      color: var(--primary); font-size: 14px; cursor: pointer; }
    .add:disabled { color: var(--text-subtle); cursor: default; }
    .name-input { box-sizing: border-box; width: 100%; min-height: 40px; padding: 0 10px; font-size: 16px; }
    .msg { margin: 0; font-size: 12px; color: var(--text-muted); }
    .msg.warn { padding: 6px 8px; border-radius: 8px; background: var(--warning-bg); color: var(--warning-text); }
    .btns { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; }
    .primary { min-height: 40px; padding: 0 16px; background: var(--primary); color: var(--on-primary);
      border: none; border-radius: 8px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
  `,
})
export class SavedFilters {
  private service = inject(SavedFilterService);
  pid = input.required<string>();
  /** 今の条件（URL の ? より後ろ。条件がなければ空） */
  current = input.required<string>();
  applied = output<string>();

  readonly max = MAX_SAVED_FILTERS;
  list = signal<SavedFilter[]>([]);
  open = signal(false);
  naming = signal(false);
  name = signal('');
  /** 同じ名前があったときの、上書きするか聞いている相手 */
  asking = signal<SavedFilter | null>(null);
  busy = signal(false);
  error = signal(false);
  private nameEl = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  /** 今の条件と同じものがあれば、それ（ボタンの名前と ✓ に使う） */
  active = computed(() => this.list().find((f) => f.query === this.current()) ?? null);
  /** 打った名前と同じものがあるか（あれば上書きなので、20個の制限にかからない） */
  sameName = computed(() => this.list().find((f) => norm(f.name) === norm(this.name())) ?? null);
  blockedByLimit = computed(() => this.list().length >= this.max && !this.sameName());

  constructor() {
    // プロジェクトが変わったら見張り直す（前の見張りは onCleanup で外す）
    effect((onCleanup) => {
      const stop = this.service.watch(this.pid(), (l) => this.list.set(l), (e) => console.error(e));
      onCleanup(stop);
    });
  }

  toggle() {
    if (this.open()) this.close();
    else this.open.set(true);
  }

  close() {
    this.open.set(false);
    this.naming.set(false);
    this.asking.set(null);
    this.error.set(false);
  }

  pick(f: SavedFilter) {
    this.applied.emit(f.query);
    this.close();
  }

  startNaming() {
    this.name.set('');
    this.error.set(false);
    this.naming.set(true);
    // 欄が描かれてから入る
    setTimeout(() => this.nameEl()?.nativeElement.focus());
  }

  /** 日本語の変換を確定する Enter では保存しない（keydown.enter の $event は Event として届く） */
  onEnter(e: Event) {
    if ((e as KeyboardEvent).isComposing) return;
    e.preventDefault();
    this.save();
  }

  async save() {
    const n = this.name().trim();
    if (!n || !this.current() || this.busy()) return;
    const same = this.sameName();
    if (same) {
      // 中身も同じなら、聞くまでもない
      if (same.query === this.current()) this.naming.set(false);
      else this.asking.set(same);
      return;
    }
    if (this.blockedByLimit()) return;
    await this.run(() => this.service.add(this.pid(), n, this.current()));
  }

  async overwrite() {
    const f = this.asking();
    if (f) await this.run(() => this.service.overwrite(f.id, this.current()));
  }

  async remove(f: SavedFilter) {
    try {
      await this.service.remove(f.id);
    } catch (e) {
      console.error(e);
      this.error.set(true);
    }
  }

  private async run(job: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set(false);
    try {
      await job();
      this.naming.set(false);
      this.asking.set(null);
    } catch (e) {
      console.error(e);
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}