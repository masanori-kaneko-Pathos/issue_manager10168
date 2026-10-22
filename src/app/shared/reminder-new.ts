import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ReminderHub } from '../core/reminder/reminder-hub.service';
import { ReminderTarget } from '../core/reminder/reminder.service';
import { SearchService } from '../core/search/search.service';
import { Issue, MAX_FREE_REMINDERS, ProjectWithRole } from '../core/models';
import { ReminderDialog } from '../pages/issue/reminder-dialog';
import { TPipe } from '../i18n/i18n';

/** 課題から選ぶで出さない課題（もう取りかかることがない） */
const FINISHED = ['closed', 'rejected', 'merged', 'deleted'];

/**
 * リマインドの「新しく作る」画面。ログイン画面のタブのように「新規登録｜課題から選ぶ」。
 * 新規登録＝変更の画面（自由入力）をそのまま使う。課題から選ぶ＝ヘッダーの検索と同じ読み込みで、全プロジェクトから探す
 */
@Component({
  selector: 'app-reminder-new',
  imports: [FormsModule, TPipe, ReminderDialog],
  template: `
    <div class="head">
      <button type="button" class="back" (click)="back.emit()">‹ {{ 'reminder.title' | t }}</button>
    </div>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" [class.on]="tab() === 'free'" [attr.aria-selected]="tab() === 'free'"
        (click)="tab.set('free')">{{ 'reminder.tabFree' | t }}</button>
      <button type="button" role="tab" [class.on]="tab() === 'issue'" [attr.aria-selected]="tab() === 'issue'"
        (click)="openIssueTab()">{{ 'reminder.tabIssue' | t }}</button>
    </div>

    @if (tab() === 'free') {
      @if (hub.freeFull()) {
        <p class="warn">{{ 'reminder.freeMax' | t: { n: '' + max } }}</p>
      } @else {
        <app-reminder-dialog [showBack]="false" (done)="done.emit()" (cancel)="cancel.emit()" (back)="back.emit()" />
      }
    } @else {
      <input id="rm-search" type="search" [ngModel]="q()" (ngModelChange)="q.set($event)"
        [placeholder]="'reminder.searchPlaceholder' | t" [attr.aria-label]="'reminder.searchPlaceholder' | t" />
      @if (!q().trim()) {
        <p class="help">{{ 'reminder.searchHint' | t }}</p>
      } @else {
        <ul class="hits">
          @for (h of hits(); track h.issue.id) {
            <li>
              <button type="button" (click)="choose(h)">
                <span class="t">#{{ h.issue.number }} {{ h.issue.title }}</span>
                <span class="p">{{ h.project.name }}
                  @if (has(h)) { <span class="has">・{{ 'reminder.has' | t }}</span> }</span>
              </button>
            </li>
          } @empty {
            <p class="empty">{{ (search.loading() ? 'common.loading' : 'search.empty') | t }}</p>
          }
        </ul>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; }
    .head { display: flex; align-items: center; }
    .back { min-height: 36px; padding: 0 4px; margin-left: -4px; border: none; background: none; color: var(--primary);
      font: inherit; font-size: 14px; cursor: pointer; }
    .tabs { display: flex; border-bottom: 1px solid var(--border); }
    .tabs button { flex: 1; min-height: 40px; margin-bottom: -1px; border: none; border-bottom: 2px solid transparent;
      background: none; color: var(--text-muted); font: inherit; font-size: 14px; cursor: pointer; }
    .tabs button.on { color: var(--text); font-weight: bold; border-bottom-color: var(--primary); }
    .hits { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow: auto; }
    .hits button { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 6px; border: none;
      border-bottom: 1px solid var(--border); background: none; color: inherit; font: inherit; text-align: left;
      cursor: pointer; }
    .hits button:hover { background: var(--surface-alt); }
    .t { overflow-wrap: anywhere; }
    .p { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
    .has { color: var(--primary); }
    .empty { margin: 8px 0; font-size: 14px; color: var(--text-muted); }
  `,
})
export class ReminderNew implements OnInit {
  done = output<void>();
  back = output<void>();
  cancel = output<void>();
  /** 課題を選んだ（変更の画面は、窓の側で開く） */
  pick = output<ReminderTarget>();

  protected hub = inject(ReminderHub);
  protected search = inject(SearchService);
  readonly max = MAX_FREE_REMINDERS;

  tab = signal<'free' | 'issue'>('free');
  q = signal('');

  /** 当たった課題：終わっていないもの・アーカイブ中でないプロジェクトのもの。30件まで */
  hits = computed(() => this.search.find(this.q(), null)
    .filter((r) => !r.project.archived)
    .flatMap((r) => r.results
      .filter((x) => !FINISHED.includes(x.issue.status))
      .map((x) => ({ project: r.project, issue: x.issue })))
    .slice(0, 30));

  ngOnInit() {
    // 5分以内に読んでいれば、読み直さない（ヘッダーの検索と同じ取り置き）
    this.search.load();
  }

  openIssueTab() {
    this.tab.set('issue');
    setTimeout(() => document.getElementById('rm-search')?.focus());
  }

  /** その課題に、もう（完了していない）リマインドが置いてあるか */
  has(h: { project: ProjectWithRole; issue: Issue }) {
    const r = this.hub.byId(`${h.project.id}_${h.issue.id}`);
    return !!r && !r.doneAt;
  }

  choose(h: { project: ProjectWithRole; issue: Issue }) {
    this.pick.emit({
      pid: h.project.id, iid: h.issue.id, number: h.issue.number, title: h.issue.title, projectName: h.project.name,
    });
  }
}