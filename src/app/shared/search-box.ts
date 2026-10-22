import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SearchService } from '../core/search/search.service';
import { Seg, findMatch, segments, terms } from '../core/search/match';
import { IssueStatus } from '../core/models';
import { TPipe } from '../i18n/i18n';
import { ProjectService } from '../core/project/project.service';

/** すべてを探すとき、受信箱・1つのプロジェクトで出す件数 */
const PER_GROUP = 5;
/** 1つのプロジェクトの中だけを探すときの件数 */
const PER_PROJECT = 10;

/** URL から今いるプロジェクトを取り出す（課題の詳細の中も含む） */
const pidOf = (url: string) => url.match(/^\/p\/([^/?#]+)/)?.[1] ?? null;

/** 結果の1行。idx は ↑↓キーで選ぶための通し番号 */
interface Row {
  idx: number;
  link: unknown[];
  title: Seg[];
  num?: number;
  status?: IssueStatus;
  done?: boolean;
  field?: string;
  snippet?: Seg[];
  query?: Record<string, string>;
}

/**
 * ヘッダーの検索欄。PC はいつも出しておき、打つと下に結果が出る。スマホは虫めがね → 全画面。
 * プロジェクトの中では、そのプロジェクトの札が最初から付く（✕ か、空の欄で Backspace で外れる）
 */
@Component({
  selector: 'app-search-box',
  imports: [RouterLink, NgTemplateOutlet, TPipe],
  host: { '[class.mobile]': 'isMobile()', '(document:keydown.escape)': 'open() && close()' },
  template: `
    @if (isMobile()) {
      <button type="button" class="icon-btn" [attr.aria-label]="'search.title' | t" (click)="openFull()">
        <ng-container [ngTemplateOutlet]="glass" />
      </button>
      @if (open()) {
        <div class="full" role="dialog" aria-modal="true" [attr.aria-label]="'search.title' | t" animate.leave="im-out">
          <ng-container [ngTemplateOutlet]="bar" />
          <ng-container [ngTemplateOutlet]="results" />
        </div>
      }
    } @else {
      <div class="anchor">
        @if (open()) { <div class="backdrop" (click)="close()"></div> }
        <ng-container [ngTemplateOutlet]="bar" />
        @if (open()) {
          <div class="panel" animate.leave="im-out"><ng-container [ngTemplateOutlet]="results" /></div>
        }
      </div>
    }

    <ng-template #glass>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    </ng-template>

    <ng-template #bar>
      <div class="bar" [class.on]="open()">
        <ng-container [ngTemplateOutlet]="glass" />
        @if (scopePid()) {
          <span class="chip"><span class="chip-name" [title]="projName()">{{ projName() || ('search.thisProject' | t) }}</span>
            <button type="button" [attr.aria-label]="'search.removeScope' | t" (click)="unscope()">✕</button>
          </span>
        }
        <input #box type="search" name="q" autocomplete="off" [value]="q()"
          (focus)="onFocus()" (input)="onQ($any($event.target).value)" (keydown)="onKey($event)"
          role="combobox" aria-controls="search-results" [attr.aria-expanded]="open()"
          [attr.aria-activedescendant]="open() && view().flat.length ? 'sr-' + active() : null"
          [placeholder]="(scopePid() ? 'search.placeholderIn' : 'search.placeholder') | t" />
        @if (isMobile()) {
          <button type="button" class="x" [attr.aria-label]="'list.close' | t" (click)="close()">✕</button>
        } @else if (!open()) {
          <kbd aria-hidden="true">/</kbd>
        }
      </div>
    </ng-template>

    <ng-template #results>
      <div class="results" id="search-results" role="listbox">
        @let v = view();
        @if (pid() && !scopePid() && projName()) {
          <button type="button" class="rescope" (click)="rescope()">
            {{ 'search.onlyIn' | t: { name: projName() } }}</button>
        }
        @if (!v.has) {
          <p class="hint">{{ 'search.hint' | t }}</p>
        } @else {
          @if (v.memos.length) {
            <h3>{{ 'search.inbox' | t }}</h3>
            <ul>
              @for (r of v.memos; track r.idx) {
                <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: r }" />
              }
            </ul>
            @if (v.memoTotal > v.memos.length) {
              <a class="more" routerLink="/inbox" (click)="done()">{{ 'search.moreInbox' | t }}</a>
            }
          }
          @for (g of v.groups; track g.pid) {
            <h3>{{ g.name }}</h3>
            @if (g.loading) {
              <p class="note">{{ 'common.loading' | t }}</p>
            } @else if (g.error) {
              <p class="note err">{{ 'search.loadError' | t }}</p>
            } @else {
              <ul>
                @for (r of g.rows; track r.idx) {
                  <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: r }" />
                }
              </ul>
              @if (g.total > g.rows.length) {
                <button type="button" class="more" (click)="seeAll(g.pid)">
                  {{ 'search.seeAll' | t: { n: '' + g.total } }}</button>
              }
            }
          }
          @if (loading() && !v.groups.length) {
            <p class="note">{{ 'common.loading' | t }}</p>
          } @else if (!v.memos.length && !v.groups.length) {
            <p class="hint">{{ 'search.empty' | t }}</p>
          }
        }
      </div>
    </ng-template>

    <ng-template #row let-r>
      <li role="option" [id]="'sr-' + r.idx" [attr.aria-selected]="r.idx === active()"
        [class.active]="r.idx === active()" [class.done]="r.done" (mouseenter)="active.set(r.idx)">
        <a [routerLink]="r.link" [queryParams]="r.query ?? null" (click)="done()">
          <span class="r-title">@if (r.num !== undefined) {<span class="num">#{{ r.num }} </span>}@for (g of r.title; track $index) {<span [class.hit]="g.hit">{{ g.text }}</span>}</span>
          @if (r.status && r.status !== 'open') { <span class="st">{{ 'status.' + r.status | t }}</span> }
          @if (r.snippet) {
            <span class="snip"><span class="field">{{ r.field | t }}：</span>@for (g of r.snippet; track $index) {<span [class.hit]="g.hit">{{ g.text }}</span>}</span>
          }
        </a>
      </li>
    </ng-template>
  `,
  styles: `
    :host { flex: 1; min-width: 0; display: flex; justify-content: center; }
    :host(.mobile) { justify-content: flex-end; }
    .anchor { position: relative; z-index: 53; width: min(480px, 100%); }
    .backdrop { position: fixed; inset: 0; z-index: 0; }
    .bar { position: relative; z-index: 1; display: flex; align-items: center; gap: 6px; height: 36px;
      padding: 0 10px; border-radius: 18px; background: rgba(255, 255, 255, 0.15); color: var(--on-primary); }
    .bar.on { background: var(--surface); color: var(--text); }
    /* 帯の中の欄なので、入力欄の基準（高さ 44px・内側の余白・角）は打ち消す */
    .bar input { flex: 1; min-width: 0; height: 100%; min-height: 0; padding: 0; border: none; border-radius: 0;
      outline: none; background: none; color: inherit; font-size: 15px; }
    .bar input::placeholder { color: inherit; opacity: 0.7; }
    .chip { display: inline-flex; align-items: center; gap: 2px; max-width: 45%; padding: 0 2px 0 8px;
      border-radius: 12px; background: var(--primary-bg); color: var(--primary); font-size: 12px;
      font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chip button { width: 24px; height: 24px; flex: none; border: none; background: none; color: inherit;
      font-size: 11px; cursor: pointer; }
    .chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    kbd { padding: 0 6px; border: 1px solid currentColor; border-radius: 4px; font-size: 11px; opacity: 0.7; }
    .panel { position: absolute; z-index: 1; top: calc(100% + 6px); left: 0; right: 0; max-height: 70vh;
      overflow: auto; background: var(--surface); color: var(--text); border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
    .icon-btn { width: 36px; height: 36px; padding: 0; border: none; border-radius: 50%; display: flex;
      align-items: center; justify-content: center; color: var(--on-primary);
      background: rgba(255, 255, 255, 0.15); cursor: pointer; }
    .full { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column;
      background: var(--surface); color: var(--text); }
    .full .bar { height: 56px; border-radius: 0; background: var(--surface); color: var(--text);
      border-bottom: 1px solid var(--border); }
    .full .results { flex: 1; overflow: auto; }
    .x { width: 40px; height: 40px; border: none; background: none; color: var(--text-muted); font-size: 16px; }
    .results { padding: 4px 0 8px; }
    .rescope { display: block; margin: 6px 12px; min-height: 32px; padding: 0 12px; border: 1px dashed var(--primary);
      border-radius: 16px; background: none; color: var(--primary); font-size: 12px; cursor: pointer; }
    h3 { margin: 10px 14px 4px; font-size: 12px; color: var(--text-muted); font-weight: bold; }
    ul { list-style: none; margin: 0; padding: 0; }
    li a { display: flex; flex-direction: column; gap: 2px; padding: 8px 14px; color: var(--text); text-decoration: none; }
    li.active a { background: var(--surface-alt); }
    li.done .r-title { color: var(--text-subtle); }
    .r-title { font-size: 14px; overflow-wrap: anywhere; }
    .num { color: var(--text-muted); }
    .st { align-self: flex-start; font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--surface-muted); }
    .snip { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .field { color: var(--text-subtle); }
    .hit { background: var(--warning-bg); color: var(--text); font-weight: bold; border-radius: 2px; }
    .more { display: block; width: 100%; min-height: 40px; padding: 0 14px; border: none; background: none;
      color: var(--primary); text-align: left; font-size: 13px; line-height: 40px; text-decoration: none; cursor: pointer; }
    .note, .hint { margin: 8px 14px; font-size: 13px; color: var(--text-muted); line-height: 1.6; }
    .err { color: var(--danger-text); }
  `,
})
export class SearchBox {
  private search = inject(SearchService);
  private router = inject(Router);

  /** 今いるプロジェクト（プロジェクトの外なら null） */
  pid = signal<string | null>(pidOf(this.router.url));
  /** 札を付けているか（プロジェクトに入るたびに付け直す） */
  scoped = signal(true);
  /** 札が付いているときの、探す範囲のプロジェクト */
  scopePid = computed(() => (this.scoped() ? this.pid() : null));
  projName = computed(() => {
    const p = this.pid();
    return p ? this.search.nameOf(p) || this.names()[p] || '' : '';
  });
  private ps = inject(ProjectService);
  /** 札に出すプロジェクト名（検索の読み込みを待たずに、プロジェクトの文書を1回だけ読んでおく） */
  private names = signal<Record<string, string>>({});

  private async ensureName(pid: string | null) {
    if (!pid || this.names()[pid]) return;
    try {
      const p = await this.ps.get(pid);
      if (p) this.names.update((m) => ({ ...m, [pid]: p.name }));
    } catch {
      // 読めなくても、「このプロジェクト」と出るだけ
    }
  }

  q = signal('');
  open = signal(false);
  /** ↑↓キーで選んでいる行の通し番号 */
  active = signal(0);
  loading = this.search.loading;
  private box = viewChild<ElementRef<HTMLInputElement>>('box');

  private mq = window.matchMedia('(max-width: 600px)');
  isMobile = signal(this.mq.matches);

  constructor() {
    // 画面を移るたびに、今いるプロジェクトを見直す。別のプロジェクトに入ったら札を付け直す
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed()).subscribe(() => {
      const p = pidOf(this.router.url);
      if (p !== this.pid()) {
        this.pid.set(p);
        this.scoped.set(true);
        this.ensureName(p);
      }
    });
    this.ensureName(this.pid()); // 最初にプロジェクトの中で開いたとき
    const onChange = (e: MediaQueryListEvent) => {
      this.isMobile.set(e.matches);
      this.close();
    };
    this.mq.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => this.mq.removeEventListener('change', onChange));
  }

  /** 画面に出す形にまとめる。受信箱 → プロジェクトの順に、行へ通し番号を振る */
  view = computed(() => {
    const q = this.q();
    const ts = terms(q);
    const scope = this.scopePid();
    const limit = scope ? PER_PROJECT : PER_GROUP;
    const flat: Row[] = [];
    const add = (r: Omit<Row, 'idx'>): Row => {
      const row = { ...r, idx: flat.length };
      flat.push(row);
      return row;
    };

    // 受信箱は、札がないときだけ（プロジェクトに属さないため）
    const memoHits = scope ? [] : this.search.findMemos(q);
    const memos = memoHits.slice(0, PER_GROUP).map((m) => {
      const inTitle = ts.map((t) => findMatch(m.title, t)).find((x) => x) ?? null;
      return add({ link: ['/inbox'], query: { m: m.id }, title: segments(m.title, inTitle) });
    });

    const groups = this.search.find(q, scope).map((g) => ({
      pid: g.project.id,
      name: g.project.name,
      loading: g.loading,
      error: g.error,
      total: g.results.length,
      rows: g.results.slice(0, limit).map((r) => add({
        link: ['/p', g.project.id, 'i', r.issue.id],
        title: r.hit.title,
        num: r.issue.number,
        status: r.issue.status,
        done: !['open', 'in_progress', 'on_hold'].includes(r.issue.status),
        field: r.hit.field,
        snippet: r.hit.snippet,
      })),
    }));

    return { has: ts.length > 0, memos, memoTotal: memoHits.length, groups, flat };
  });

  /** 「/」キーから。PC は欄にカーソルを置き、スマホは全画面で開く */
  focusFromKey() {
    if (this.isMobile()) this.openFull();
    else this.box()?.nativeElement.focus();
  }

  openFull() {
    this.open.set(true);
    this.search.load();
    // 全画面が画面に出てから、欄にカーソルを置く
    setTimeout(() => this.box()?.nativeElement.focus());
  }

  onFocus() {
    this.open.set(true);
    this.search.load(); // 5分以内に読んだものがあれば、読み直さない
  }

  close() {
    this.open.set(false);
    this.box()?.nativeElement.blur();
  }

  /** 結果を開いたあとは、欄を空にして閉じる */
  done() {
    this.q.set('');
    this.active.set(0);
    this.close();
  }

  onQ(value: string) {
    this.q.set(value);
    this.active.set(0);
    this.open.set(true);
  }

  unscope() {
    this.scoped.set(false);
    this.active.set(0);
    this.box()?.nativeElement.focus();
  }

  rescope() {
    this.scoped.set(true);
    this.active.set(0);
    this.box()?.nativeElement.focus();
  }

  /** ↑↓で選び、Enter で開く（変換を確定する Enter では開かない）。空の欄で Backspace なら札を外す */
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Backspace' && !this.q() && this.scopePid()) {
      e.preventDefault();
      this.unscope();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.view().flat.length;
      this.move(e.key === 'ArrowDown' ? Math.min(n - 1, this.active() + 1) : Math.max(0, this.active() - 1));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const r = this.view().flat[this.active()];
      if (r) {
        this.router.navigate(r.link, { queryParams: r.query });
        this.done();
      }
    }
  }

  /** 選んだ行が見えるところまでスクロールする */
  private move(i: number) {
    this.active.set(i);
    document.getElementById('sr-' + i)?.scrollIntoView({ block: 'nearest' });
  }

  /** 残りは、そのプロジェクトのリストで（リストは ?q= で絞り込む） */
  seeAll(pid: string) {
    this.router.navigate(['/p', pid, 'list'], { queryParams: { q: this.q().trim() } });
    this.done();
  }
}