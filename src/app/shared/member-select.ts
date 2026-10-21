import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { auth } from '../core/firebase';
import { Member } from '../core/models';
import { TPipe } from '../i18n/i18n';
import { Avatar } from './avatar';

/** 一覧の id を、部品ごとに別にするための番号（同じ画面に2つ置いても、ぶつからないように） */
let seq = 0;
/** 名前を比べる形（全角半角・大文字小文字をそろえる。人の絞り込みと同じ） */
const norm = (s: string) => s.normalize('NFKC').toLowerCase();

/**
 * 担当者を選ぶ（打って絞れる）。自分を先頭に、あとは名前順。
 * 一覧は浮かせず、下に広げる（窓の中では、浮かせた一覧が窓の縁で切れるため）。
 * 閲覧者や本人を外すのは、呼ぶ側で済ませてから渡す（場面ごとに外す人が違うため）
 */
@Component({
  selector: 'app-member-select',
  imports: [TPipe, Avatar],
  host: { '(document:click)': 'onDocClick($event)' },
  template: `
    <div class="wrap" (keydown.escape)="onEsc($event)">
      <!-- 外の label の for と結ぶ id は、このボタンに付ける（ラベルを押すと開く） -->
      <button #trigger type="button" class="trigger" [attr.id]="selectId()" aria-haspopup="listbox"
        [attr.aria-expanded]="open()" (click)="toggle()" (keydown.arrowdown)="openFromKey($event)">
        @if (current(); as m) {
          <app-avatar [name]="m.displayName" [uid]="m.uid" [photo]="m.photoURL" [size]="22" />
          <span class="name">{{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</span>
        } @else {
          <span class="name muted">{{ placeholder() ? (placeholder()! | t) : '—' }}</span>
        }
        <span class="caret" aria-hidden="true">{{ open() ? '▴' : '▾' }}</span>
      </button>
      @if (open()) {
        <!-- 外の label に「押した」を伝えない（伝わると、開くボタンが押されたことになり、開き直る） -->
        <div class="panel" (click)="$event.preventDefault()">
          <input #search type="text" class="search" role="combobox" autocomplete="off"
            aria-expanded="true" [attr.aria-controls]="listId" [attr.aria-activedescendant]="activeId()"
            [placeholder]="'memberSelect.search' | t" [attr.aria-label]="'memberSelect.search' | t"
            [value]="query()" (input)="onInput($any($event.target).value)" (keydown)="onKey($event)" />
          <ul class="rows" role="listbox" [id]="listId">
            @for (m of shown(); track m.uid; let k = $index) {
              <li role="presentation">
                <button type="button" role="option" class="row" [id]="listId + '-' + k" tabindex="-1"
                  [attr.aria-selected]="m.uid === value()" [class.active]="k === active()" [class.on]="m.uid === value()"
                  (mouseenter)="active.set(k)" (click)="pick(m.uid)">
                  <app-avatar [name]="m.displayName" [uid]="m.uid" [photo]="m.photoURL" [size]="22" />
                  <span class="name">{{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</span>
                  @if (m.uid === value()) { <span class="check" aria-hidden="true">✓</span> }
                </button>
              </li>
            } @empty {
              <li class="none">{{ 'who.noMatch' | t }}</li>
            }
          </ul>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; width: 100%; max-width: 360px; }
    .trigger { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); color: var(--text);
      font-size: 16px; font-weight: normal; text-align: left; cursor: pointer; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: var(--text-subtle); }
    .caret { font-size: 12px; color: var(--text-muted); }
    .panel { margin-top: 4px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface);
      overflow: hidden; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
    .search { display: block; box-sizing: border-box; width: 100%; min-height: 40px; padding: 0 10px; border: none;
      border-bottom: 1px solid var(--border); background: var(--surface); color: var(--text);
      font-size: 16px; font-weight: normal; }
    .rows { list-style: none; margin: 0; padding: 4px 0; max-height: min(240px, 40vh); overflow-y: auto; }
    .row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 0 12px;
      border: none; background: none; color: var(--text); font-size: 14px; font-weight: normal; text-align: left;
      cursor: pointer; }
    .row.active { background: var(--surface-alt); }
    .row.on .name { font-weight: bold; }
    .check { color: var(--primary); font-weight: bold; }
    .none { padding: 8px 12px; font-size: 13px; font-weight: normal; color: var(--text-muted); }
  `,
})
export class MemberSelect {
  members = input.required<Member[]>();
  /** 今選ばれている人の uid（まだ選んでいなければ null） */
  value = input<string | null>(null);
  /** 選んでいないときに出す文の翻訳キー */
  placeholder = input<string | null>(null);
  /** 外の label と結ぶための id（開くボタンに付ける） */
  selectId = input<string | null>(null);
  picked = output<string>();

  private host = inject(ElementRef<HTMLElement>);
  private triggerEl = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private searchEl = viewChild<ElementRef<HTMLInputElement>>('search');

  readonly myUid = auth.currentUser!.uid;
  readonly listId = `ms-${++seq}`;
  open = signal(false);
  query = signal('');
  /** ↑↓ で選んでいる行（絞った一覧の中の番号） */
  active = signal(0);

  sorted = computed(() => [...this.members()].sort((a, b) =>
    Number(b.uid === this.myUid) - Number(a.uid === this.myUid) || a.displayName.localeCompare(b.displayName)));
  /** 今選ばれている人（選択肢の中にいなければ null → placeholder を出す） */
  current = computed(() => this.members().find((m) => m.uid === this.value()) ?? null);
  shown = computed(() => {
    const q = norm(this.query().trim());
    return q ? this.sorted().filter((m) => norm(m.displayName).includes(q)) : this.sorted();
  });
  activeId = computed(() => (this.shown().length ? `${this.listId}-${this.active()}` : null));

  toggle() {
    if (this.open()) {
      this.close();
      return;
    }
    this.query.set('');
    // 開いたときは、今選んでいる人の行から（↓ を押すと、その次へ）
    this.active.set(Math.max(0, this.sorted().findIndex((m) => m.uid === this.value())));
    this.open.set(true);
    setTimeout(() => {
      this.searchEl()?.nativeElement.focus();
      this.scrollActive();
    });
  }

  openFromKey(e: Event) {
    e.preventDefault();
    if (!this.open()) this.toggle();
  }

  close() {
    this.open.set(false);
  }

  onInput(v: string) {
    this.query.set(v);
    this.active.set(0);
  }

  /** ↑↓ で動かし、Enter で決める。form の中でも、Enter で送信されないように止める */
  onKey(e: KeyboardEvent) {
    const n = this.shown().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      this.active.set((this.active() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      this.scrollActive();
    } else if (e.key === 'Enter') {
      if (e.isComposing) return; // 日本語の変換を確定する Enter では決めない
      e.preventDefault();
      const m = this.shown()[this.active()];
      if (m) this.pick(m.uid);
    }
  }

  /** 一覧が開いているときの Esc は、一覧を閉じるだけ（外の窓や項目の編集まで閉じないよう、外へ伝えない） */
  onEsc(e: Event) {
    if (!this.open()) return;
    e.stopPropagation();
    this.close();
    this.triggerEl()?.nativeElement.focus();
  }

  pick(uid: string) {
    this.picked.emit(uid);
    this.close();
    this.triggerEl()?.nativeElement.focus();
  }

  /** 部品の外を押したら閉じる */
  onDocClick(e: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.close();
  }

  /** ↑↓ で選んだ行が、一覧の見える所に入るように */
  private scrollActive() {
    setTimeout(() => document.getElementById(`${this.listId}-${this.active()}`)?.scrollIntoView({ block: 'nearest' }));
  }
}