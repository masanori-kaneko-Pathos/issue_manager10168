import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { ParamMap } from '@angular/router';
import { auth } from '../core/firebase';
import { Member } from '../core/models';
import { I18nService, TPipe } from '../i18n/i18n';
import { Avatar } from './avatar';

/**
 * URL から「選んだ人」を読む。読む順は who → mine=1（自分）→ assignee（その人）。
 * mine と assignee は古い形（お知らせの引き継ぎが ?assignee= で来るため、読めるように残す）
 */
export function whoFromQuery(p: ParamMap, myUid: string): string[] {
  const who = p.get('who');
  if (who) return [...new Set(who.split(',').filter(Boolean))];
  if (p.get('mine') === '1') return [myUid];
  const a = p.get('assignee');
  return a ? [a] : [];
}

/** URL に書く形。いつも who にそろえ、古い形は消す。だれも選んでいなければ who も消す（＝全員） */
export function whoQuery(who: string[]) {
  return { who: who.length ? who.join(',') : null, mine: null, assignee: null };
}

/**
 * 人の絞り込み（ボタン1つ ＋ 吹き出し）。自分が先頭、あとは名前順。押すたびに入る・外れる。
 * 選んでいる人は外が持ち、ここは picked で知らせるだけ（帳簿は1冊）
 */
@Component({
  selector: 'app-people-filter',
  imports: [TPipe, Avatar],
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <div class="wrap">
      <button type="button" class="trigger" [class.on]="value().length > 0" aria-haspopup="true"
        [attr.aria-expanded]="open()" [attr.aria-label]="('who.open' | t) + '：' + label()" (click)="toggle()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
        </svg>
        <span class="text">{{ label() }}</span>
        <span aria-hidden="true">▾</span>
      </button>
      @if (open()) {
        <div class="backdrop" (click)="close()"></div>
        <div class="pop" role="menu" animate.leave="im-out">
          <!-- 一覧のスクロールの外に置くので、いつも一番上に見えている -->
          <button type="button" role="menuitemradio" class="row all" [attr.aria-checked]="!value().length"
            (click)="clearAll()">
            <span class="check" aria-hidden="true">{{ value().length ? '' : '✓' }}</span>
            <span class="name">{{ 'who.all' | t }}</span>
          </button>
          @if (members().length >= 7) {
            <input #search type="search" class="search" [placeholder]="'who.search' | t"
              [attr.aria-label]="'who.search' | t" [value]="query()" (input)="query.set($any($event.target).value)" />
          }
          <div class="rows">
            @for (m of shown(); track m.uid) {
              @let on = chosen().has(m.uid);
              @let n = counts()[m.uid] ?? 0;
              <button type="button" role="menuitemcheckbox" class="row" [attr.aria-checked]="on" (click)="toggleOne(m.uid)">
                <span class="check" aria-hidden="true">{{ on ? '✓' : '' }}</span>
                <app-avatar [name]="m.displayName" [uid]="m.uid" [photo]="m.photoURL" [size]="22" />
                <span class="name">{{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</span>
                <span class="n" [title]="'who.count' | t: { n: '' + n }">{{ n }}</span>
              </button>
            } @empty {
              <p class="none">{{ 'who.noMatch' | t }}</p>
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
    .pop { position: absolute; left: 0; top: calc(100% + 4px); z-index: 52; width: min(280px, calc(100vw - 32px));
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); padding: 6px 0; }
    .search { display: block; box-sizing: border-box; width: calc(100% - 16px); margin: 2px 8px 6px;
      min-height: 40px; padding: 0 10px; font-size: 16px; }
    .rows { max-height: min(360px, 60vh); overflow-y: auto; display: flex; flex-direction: column; }
    /* flex の中の行は、縮んでつぶれないように（統合の窓で学んだこと） */
    .row { flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 12px;
      background: none; border: none; text-align: left; font-size: 14px; color: var(--text); cursor: pointer; }
    .row:hover { background: var(--surface-alt); }
    /* 「全員」は人の一覧と区切る。ボタンは中身の幅に縮むので、横いっぱいに広げる */
    .row.all { width: 100%; box-sizing: border-box; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
    .check { width: 16px; flex: none; color: var(--primary); font-weight: bold; }
    .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .n { font-size: 11px; color: var(--text-subtle); }
    .none { margin: 8px 12px; font-size: 13px; color: var(--text-subtle); }
  `,
})
export class PeopleFilter {
  private i18n = inject(I18nService);
  /** 選べる人（担当者になれる人）。外す人は呼ぶ側で済ませてから渡す */
  members = input.required<Member[]>();
  /** 人ごとの未完了の件数 */
  counts = input<Record<string, number>>({});
  /** 今選んでいる人（空＝全員） */
  value = input<string[]>([]);
  picked = output<string[]>();

  readonly myUid = auth.currentUser!.uid;
  open = signal(false);
  query = signal('');
  private searchEl = viewChild<ElementRef<HTMLInputElement>>('search');

  sorted = computed(() => [...this.members()].sort((a, b) =>
    Number(b.uid === this.myUid) - Number(a.uid === this.myUid) || a.displayName.localeCompare(b.displayName)));
  chosen = computed(() => new Set(this.value()));

  /** 名前で絞った一覧（全角半角・大文字小文字をそろえて比べる） */
  shown = computed(() => {
    const norm = (s: string) => s.normalize('NFKC').toLowerCase();
    const q = norm(this.query().trim());
    return q ? this.sorted().filter((m) => norm(m.displayName).includes(q)) : this.sorted();
  });

  /** ボタンの文字：全員／1人は名前（自分なら「自分」）／2人は「自分、Aさん」／3人以上は「n人」 */
  label = computed(() => {
    const ids = this.sorted().map((m) => m.uid).filter((u) => this.chosen().has(u));
    const name = (uid: string) => uid === this.myUid
      ? this.i18n.t('who.me')
      : this.members().find((m) => m.uid === uid)?.displayName ?? '';
    if (!ids.length) return this.i18n.t('who.all');
    if (ids.length === 1) return name(ids[0]);
    if (ids.length === 2) return this.i18n.t('who.two', { a: name(ids[0]), b: name(ids[1]) });
    return this.i18n.t('who.many', { n: String(ids.length) });
  });

  toggle() {
    if (this.open()) {
      this.close();
      return;
    }
    this.query.set('');
    this.open.set(true);
    // 欄が描かれてから、名前で絞る欄に入る（7人以上のときだけある）
    setTimeout(() => this.searchEl()?.nativeElement.focus());
  }

  close() {
    this.open.set(false);
  }

  /** 全員に戻す（だれも選んでいない状態）。もう全員なら何もしない（URL を書き直さないため） */
  clearAll() {
    if (this.value().length) this.picked.emit([]);
  }

  /** 押すたびに入る・外れる。並びは一覧の順にそろえて知らせる（URL の並びが毎回変わらないように） */
  toggleOne(uid: string) {
    const s = new Set(this.value());
    if (s.has(uid)) s.delete(uid);
    else s.add(uid);
    this.picked.emit(this.sorted().map((m) => m.uid).filter((u) => s.has(u)));
  }
}