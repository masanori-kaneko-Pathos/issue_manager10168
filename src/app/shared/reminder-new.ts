import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ReminderHub } from '../core/reminder/reminder-hub.service';
import { ReminderTarget } from '../core/reminder/reminder.service';
import { SearchService } from '../core/search/search.service';
import { Issue, MAX_REMINDERS, ProjectWithRole } from '../core/models';
import { ReminderDialog } from '../pages/issue/reminder-dialog';
import { HelpTip } from './help-tip';
import { TPipe } from '../i18n/i18n';

/** 課題から選ぶで出さない課題（もう取りかかることがない） */
const FINISHED = ['closed', 'rejected', 'merged', 'deleted'];

type Hit = { project: ProjectWithRole; issue: Issue };

/**
 * リマインドの「新しく作る」画面。ログイン画面のタブのように「新規登録｜課題から選ぶ」。
 * 上の段（内容とメモ／探す欄とメモ）はこの画面が持ち、高さを決めておく。説明は、選んでいるタブの横の「？」に。
 * 課題の当たりは、ヘッダーの検索のように、探す欄の下に浮く一覧で出す。選ぶたびに、新しいリマインドになる
 * （1つの課題にいくつでも置ける）。下の段（時刻の欄とボタン）は、どちらのタブでも同じ部品
 */
@Component({
  selector: 'app-reminder-new',
  imports: [FormsModule, TPipe, ReminderDialog, HelpTip],
  host: { '(document:click)': 'onDocClick($event)' },
  template: `
    <div class="head">
      <button type="button" class="back" (click)="back.emit()">‹ {{ 'reminder.title' | t }}</button>
    </div>
    <!-- タブ：選んでいるタブの横にだけ「？」。タブの面のどこを押しても切り替わる -->
    <div class="tabs" role="tablist">
      <div class="tab" [class.on]="tab() === 'free'" (click)="openFreeTab()">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'free'">{{ 'reminder.tabFree' | t }}</button>
        @if (tab() === 'free') { <app-help-tip [keys]="['reminder.freeHelp']" /> }
      </div>
      <div class="tab" [class.on]="tab() === 'issue'" (click)="openIssueTab()">
        <button type="button" role="tab" [attr.aria-selected]="tab() === 'issue'">{{ 'reminder.tabIssue' | t }}</button>
        @if (tab() === 'issue') { <app-help-tip align="right" [keys]="['reminder.searchHint']" /> }
      </div>
    </div>

    <!-- 上の段：高さを決めておく -->
    <div class="top">
      @if (hub.full()) {
        <p class="warn">{{ 'reminder.freeMax' | t: { n: '' + max } }}</p>
      } @else if (tab() === 'free') {
        <label class="field">{{ 'reminder.freeTitle' | t }}
          <input id="rm-title" [ngModel]="title()" (ngModelChange)="title.set($event)" maxlength="200"
            [placeholder]="'reminder.freePlaceholder' | t" />
        </label>
        <label class="field">{{ 'reminder.note' | t }}
          <textarea [ngModel]="note()" (ngModelChange)="note.set($event)" rows="2" maxlength="1000"
            [placeholder]="'reminder.notePlaceholder' | t"></textarea>
        </label>
      } @else {
        <div class="combo">
          <input id="rm-search" type="search" role="combobox" autocomplete="off" aria-controls="rm-hits"
            [attr.aria-expanded]="listShown()" [attr.aria-activedescendant]="listShown() ? 'rm-hit-' + active() : null"
            [value]="q()" (input)="onSearch($any($event.target).value)" (focus)="openList()" (keydown)="onKey($event)"
            [placeholder]="'reminder.searchPlaceholder' | t" [attr.aria-label]="'reminder.searchPlaceholder' | t" />
          @if (listShown()) {
            <!-- 浮く一覧（下の欄の上に重なる。窓の形は変わらない） -->
            <ul id="rm-hits" class="drop" role="listbox">
              @for (h of hits(); track h.issue.id; let k = $index) {
                <li role="presentation">
                  <button type="button" role="option" tabindex="-1" [id]="'rm-hit-' + k" [class.active]="k === active()"
                    [attr.aria-selected]="k === active()" (mouseenter)="active.set(k)" (click)="choose(h)">
                    <span class="t">#{{ h.issue.number }} {{ h.issue.title }}</span>
                    <span class="p">{{ h.project.name }}</span>
                  </button>
                </li>
              } @empty {
                <li class="none">{{ (search.loading() ? 'common.loading' : 'search.empty') | t }}</li>
              }
            </ul>
          }
        </div>
        @if (sel(); as s) {
          <p class="picked">{{ s.projectName }}</p>
        } @else {
          <p class="picked muted">{{ 'reminder.pickLine' | t }}</p>
        }
        <label class="field">{{ 'reminder.note' | t }}
          <textarea [ngModel]="issueNote()" (ngModelChange)="issueNote.set($event)" rows="2" maxlength="1000"
            [placeholder]="'reminder.notePlaceholder' | t"></textarea>
        </label>
      }
    </div>

    <!-- 下の段：時刻の欄とボタン。タブを替えたときだけ作り直す（課題を選び直しても、選んだ時刻は残す） -->
    @for (k of [tab()]; track k) {
      <app-reminder-dialog [compact]="true" [needTarget]="tab() === 'issue'"
        [target]="tab() === 'issue' ? sel() : null"
        [extTitle]="title()" [extNote]="tab() === 'free' ? note() : issueNote()"
        (done)="done.emit()" (cancel)="cancel.emit()" />
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; }
    .head { display: flex; align-items: center; }
    .back { min-height: 36px; padding: 0 4px; margin-left: -4px; border: none; background: none; color: var(--primary);
      font: inherit; font-size: 14px; cursor: pointer; }
    .tabs { display: flex; border-bottom: 1px solid var(--border); }
    .tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px;
      margin-bottom: -1px; border-bottom: 2px solid transparent; cursor: pointer; }
    .tab.on { border-bottom-color: var(--primary); }
    .tab button { padding: 0 4px; border: none; background: none; color: var(--text-muted); font: inherit;
      font-size: 14px; cursor: pointer; }
    .tab.on button { color: var(--text); font-weight: bold; }
    /* 上の段：どちらのタブでも同じ高さ */
    .top { height: 170px; display: flex; flex-direction: column; gap: 8px; }
    .top textarea { resize: none; }
    /* 探す欄と、その下に浮く一覧 */
    .combo { position: relative; }
    .combo input { width: 100%; }
    .drop { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; margin: 0; padding: 4px 0;
      list-style: none; max-height: 240px; overflow-y: auto; background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      animation: im-pop 160ms var(--ease-out); }
    .drop button { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 12px; border: none;
      background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .drop button.active { background: var(--surface-alt); }
    .none { padding: 8px 12px; font-size: 13px; color: var(--text-muted); }
    .t { overflow-wrap: anywhere; }
    .p { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    /* 選んだ課題のプロジェクト名（選ぶ前は案内）。いつも1行の高さ */
    .picked { margin: 0; min-height: 18px; font-size: 12px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picked.muted { color: var(--text-muted); }
  `,
})
export class ReminderNew implements OnInit {
  done = output<void>();
  back = output<void>();
  cancel = output<void>();

  protected hub = inject(ReminderHub);
  protected search = inject(SearchService);
  readonly max = MAX_REMINDERS;

  tab = signal<'free' | 'issue'>('free');
  /** 新規登録の内容とメモ */
  title = signal('');
  note = signal('');
  /** 課題から選ぶの、探す言葉・選んでいる課題・メモ */
  q = signal('');
  sel = signal<ReminderTarget | null>(null);
  issueNote = signal('');
  /** 浮く一覧を開いているか・↑↓ で選んでいる行 */
  listOpen = signal(false);
  active = signal(0);

  /** 一覧を出すのは、打っていて、まだ選んでいないとき */
  listShown = computed(() => this.listOpen() && !!this.q().trim() && !this.sel());

  /** 当たった課題：終わっていないもの・アーカイブ中でないプロジェクトのもの。30件まで */
  hits = computed<Hit[]>(() => this.search.find(this.q(), null)
    .filter((r) => !r.project.archived)
    .flatMap((r) => r.results
      .filter((x) => !FINISHED.includes(x.issue.status))
      .map((x) => ({ project: r.project, issue: x.issue })))
    .slice(0, 30));

  ngOnInit() {
    // 5分以内に読んでいれば、読み直さない（ヘッダーの検索と同じ取り置き）
    this.search.load();
    this.focusLater('rm-title');
  }

  openFreeTab() {
    if (this.tab() === 'free') return;
    this.tab.set('free');
    this.focusLater('rm-title');
  }

  openIssueTab() {
    if (this.tab() === 'issue') return;
    this.tab.set('issue');
    this.focusLater('rm-search');
  }

  private focusLater(id: string) {
    setTimeout(() => document.getElementById(id)?.focus());
  }

  /** 打ち直したら、選んだ課題は外す（欄の文字と、選んだ課題が食い違わないように） */
  onSearch(v: string) {
    this.q.set(v);
    this.sel.set(null);
    this.active.set(0);
    this.listOpen.set(true);
  }

  openList() {
    if (!this.sel()) this.listOpen.set(true);
  }

  /** ↑↓ で動かし、Enter で選ぶ。Esc は一覧だけ閉じる（窓まで閉じないよう、外へ伝えない） */
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && this.listShown()) {
      e.stopPropagation();
      this.listOpen.set(false);
      return;
    }
    const n = this.hits().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.listOpen.set(true);
      if (!n) return;
      this.active.set((this.active() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
      setTimeout(() => document.getElementById('rm-hit-' + this.active())?.scrollIntoView({ block: 'nearest' }));
    } else if (e.key === 'Enter') {
      if (e.isComposing) return; // 日本語の変換を確定する Enter では選ばない
      e.preventDefault();
      const h = this.hits()[this.active()];
      if (h && this.listShown()) this.choose(h);
    }
  }

  /** 探す欄と一覧の外を押したら、一覧を閉じる */
  onDocClick(e: MouseEvent) {
    if (this.listOpen() && !(e.target as Element | null)?.closest('.combo')) this.listOpen.set(false);
  }

  /** 課題を選ぶ：欄に「#12 課題名」を入れて一覧を閉じる（打っておいたメモと時刻は、そのまま） */
  choose(h: Hit) {
    this.sel.set({
      pid: h.project.id, iid: h.issue.id, number: h.issue.number, title: h.issue.title, projectName: h.project.name,
    });
    this.q.set(`#${h.issue.number} ${h.issue.title}`);
    this.listOpen.set(false);
  }
}