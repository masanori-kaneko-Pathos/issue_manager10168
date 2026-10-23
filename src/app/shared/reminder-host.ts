import { Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { AuthService } from '../core/auth/auth.service';
import { ReminderHub, reminderTitle } from '../core/reminder/reminder-hub.service';
import { ReminderService } from '../core/reminder/reminder.service';
import { Reminder } from '../core/models';
import { formatDateTime } from '../core/time/time';
import { ReminderDialog } from '../pages/issue/reminder-dialog';
import { ReminderNew } from './reminder-new';
import { I18nService, TPipe } from '../i18n/i18n';

/**
 * リマインドの窓（app.html に1つ）。issue-form-host と同じ作り：外・Esc・✕ で閉じ、画面を移ると閉じる。
 * URL に ?reminders=1 が付いて来たら（お知らせ・プッシュから）、一覧を開いて、その印を消す
 */
@Component({
  selector: 'app-reminder-host',
  imports: [NgTemplateOutlet, TPipe, ReminderDialog, ReminderNew],
  host: { '(document:keydown.escape)': 'onEsc($event)' },
  template: `
    @if (hub.view(); as v) {
      <div class="layer" animate.leave="im-out-dialog">
        <div class="backdrop" (click)="hub.close()"></div>
        <section class="dialog narrow" [class.rm-fixed]="v.kind !== 'edit'" role="dialog" aria-modal="true"
          [attr.aria-label]="'reminder.title' | t">
          @if (v.kind !== 'list') {
            <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t"
              (click)="hub.close()">✕</button>
          }
          @if (v.kind === 'list') {
            <div class="head">
              <h2>{{ 'reminder.title' | t }}</h2>
              <button type="button" class="icon-btn" [attr.aria-label]="'reminder.add' | t" [title]="'reminder.add' | t"
                (click)="hub.openNew()">＋</button>
              <button type="button" class="icon-btn" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t"
                (click)="hub.close()">✕</button>
            </div>

            <div class="scroll">
            @if (!hub.count()) { <p class="empty">{{ 'reminder.empty' | t }}</p> }
            @if (hub.count()) {
              <ul class="rlist">
                @for (r of hub.fired(); track r.id) {
                  <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: r, state: 'late' }" />
                }
                @for (r of hub.scheduled(); track r.id) {
                  <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: r, state: 'plan' }" />
                }
              </ul>
            }

            @if (hub.done().length) {
              <button type="button" class="fold" [attr.aria-expanded]="doneOpen()" (click)="doneOpen.set(!doneOpen())">
                <span class="tri" [class.shut]="!doneOpen()" aria-hidden="true">▾</span>
                {{ 'reminder.doneN' | t: { n: '' + hub.done().length } }}</button>
              <div class="fold-body" [class.open]="doneOpen()" [attr.inert]="doneOpen() ? null : ''">
                <ul class="rlist">
                  @for (r of hub.done(); track r.id) {
                    <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: r, state: 'done' }" />
                  }
                </ul>
              </div>
            }
            </div>
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
          } @else if (v.kind === 'edit') {
            <!-- 一覧から開いたら、終わったら一覧へ。外（課題の ⋮ など）から開いたら、終わったら閉じる -->
            <app-reminder-dialog [target]="v.target" [current]="v.rid ? hub.byId(v.rid) : null"
              (back)="hub.openList()" (cancel)="v.fromList ? hub.openList() : hub.close()"
              (done)="v.fromList ? hub.openList() : hub.close()" />
          } @else if (v.kind === 'new') {
            <!-- 課題を選んだら、その課題の変更の画面へ（終わったら一覧へ戻る） -->
            <app-reminder-new (back)="hub.openList()" (cancel)="hub.openList()" (done)="hub.openList()" />
          }
        </section>
      </div>
    }

    <!-- 1行：左の ○ で完了・戻す。題名を押すと変更の画面 -->
    <ng-template #row let-r let-state="state">
      <li class="r" [class.late]="state === 'late'" [class.done]="state === 'done'">
        <button type="button" class="check" [attr.aria-pressed]="state === 'done'" [disabled]="busy()"
          [attr.aria-label]="(state === 'done' ? 'reminder.markUndone' : 'reminder.markDone') | t: { title: titleOf(r) }"
          (click)="toggle(r)">
          @if (state === 'done') {
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor"
              stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10" /></svg>
          }
        </button>
        <button type="button" class="main" (click)="hub.openEdit(r.id)">
          <span class="title">{{ titleOf(r) }}</span>
          @if (r.note) { <span class="note">{{ r.note }}</span> }
          <span class="meta">
            <span class="when" [title]="state === 'late' ? ('reminder.fired' | t) : ''">{{ when(r) }}</span>
            @if (contextOf(r); as c) { <span class="ctx">{{ c }}</span> }
          </span>
        </button>
      </li>
    </ng-template>
  `,
  styles: `
    .layer { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 一覧と新しく作る画面は、同じ大きさに固定（行き来しても窓が伸び縮みしない）。低い画面では画面に収める */
    .dialog.rm-fixed { --rm-h: 540px; height: min(var(--rm-h), calc(100dvh - 32px));
      display: flex; flex-direction: column; overflow-y: auto; }
    /* 一覧：見出しは残して、その下だけスクロール */
    /* 横は止める。行の背景が左右に 4px はみ出すので、その分だけ箱を広げて内側に余白を取る（見た目の幅は変わらない） */
    .scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column;
      margin: 0 -4px; padding: 0 4px; }
    .head { display: flex; align-items: center; gap: 4px; }
    .head h2 { flex: 1; }
    .icon-btn { flex: none; width: 36px; height: 36px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 18px; cursor: pointer; }
    .icon-btn:hover { background: var(--surface-alt); color: var(--text); }
    .empty { margin: 8px 0; font-size: 14px; color: var(--text-muted); }
    .rlist { list-style: none; margin: 0; padding: 0; }
    .r { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    /* ○：押すと完了（✓ の丸）。もう一度押すと戻る */
    .check { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
      margin-top: 1px; padding: 0; border: 2px solid var(--border-strong); border-radius: 50%; background: var(--surface);
      color: var(--on-primary); cursor: pointer; }
    .check:hover:not(:disabled) { border-color: var(--primary); }
    .done .check { background: var(--primary); border-color: var(--primary); }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; margin: -2px -4px; padding: 2px 4px;
      border: none; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    .main:hover { background: var(--surface-alt); }
    .title { overflow-wrap: anywhere; }
    .done .title { color: var(--text-muted); text-decoration: line-through; }
    .note { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 12px; color: var(--text-muted); }
    /* 届いたもの：時刻を赤く（期限切れと同じ見た目） */
    .late .when { color: var(--danger-text); font-weight: bold; }
    .ctx { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fold { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 4px;
      border: none; background: none; color: var(--text-muted); font: inherit; font-size: 13px; cursor: pointer; }
    .tri { display: inline-block; width: 12px; font-size: 11px; text-align: center; transition: rotate 160ms var(--ease-out); }
    .tri.shut { rotate: -90deg; }
  `,
})
export class ReminderHost {
  protected hub = inject(ReminderHub);
  private reminders = inject(ReminderService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 完了済みの見出しを開いているか（最初はたたむ） */
  doneOpen = signal(false);
  busy = signal(false);
  error = signal('');

  constructor() {
    const router = inject(Router);
    // 窓の中から別の画面へ移ったら（課題の題名を押した、など）、窓を閉じる
    router.events.pipe(filter((e) => e instanceof NavigationStart), takeUntilDestroyed())
      .subscribe(() => this.hub.close());
    // ?reminders=1 で来たら：先に印を消してから開く（消す移動で閉じてしまわないように、移動が済んでから）
    router.events.pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => {
        if (router.parseUrl(router.url).queryParams['reminders'] !== '1') return;
        router.navigate([], { queryParams: { reminders: null }, queryParamsHandling: 'merge', replaceUrl: true })
          .then(() => this.hub.openList());
      });
  }

  /** 1行目（決まりは hub の reminderTitle。引き出しと同じ） */
  titleOf(r: Reminder) {
    return reminderTitle(r);
  }

  /** 時刻の横に薄く出す：サブタスクは「#12 課題名」、課題はプロジェクト名、自由入力はなし */
  contextOf(r: Reminder) {
    if (r.sid) return `#${r.number} ${r.title}`;
    return r.pid ? r.projectName ?? '' : '';
  }

  when(r: Reminder) {
    return formatDateTime(r.at.toDate(), this.tz(), this.i18n.lang());
  }

  async toggle(r: Reminder) {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.reminders.setDone(r, !r.doneAt);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 窓を閉じたら印を付ける（後ろの引き出しが、同じ Esc で閉じないように） */
  onEsc(e: Event) {
    if (!this.hub.view()) return;
    e.preventDefault();
    this.hub.close();
  }
}