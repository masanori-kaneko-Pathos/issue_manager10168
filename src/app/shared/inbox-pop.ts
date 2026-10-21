import { ApplicationRef, Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { smoothly } from '../core/smoothly';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InboxService, pinnedStable, splitMemo } from '../core/inbox/inbox.service';
import { MemoRow } from './memo-row';
import { IS_TOUCH, enterKey } from '../core/dom';
import { TPipe } from '../i18n/i18n';

/**
 * ペンの吹き出し。上に最近のメモを3つ、下に書く欄。
 * 欄は1つで、1行目がタイトル・2行目から詳しいこと。Enter で受信箱に入れる（Shift＋Enter で改行）
 */
@Component({
  selector: 'app-inbox-pop',
  imports: [FormsModule, RouterLink, TPipe, MemoRow],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="pop" role="dialog" [attr.aria-label]="'inbox.write' | t">
      <div class="head">
        <span class="h">{{ 'inbox.recent' | t }}</span>
        <a routerLink="/inbox" class="all" (click)="close.emit()">{{ 'inbox.seeAll' | t: { n: '' + inbox.count() } }}</a>
      </div>
      <ul class="recent">
        @for (m of recent(); track m.id) {
          <li [style.view-transition-name]="'pop-memo-' + m.id">
            <app-memo-row [memo]="m" [compact]="true" touchUi="menu" (leave)="close.emit()" (saved)="bump(m.id)" />
          </li>
        } @empty {
          <li class="empty">{{ 'inbox.empty' | t }}</li>
        }
      </ul>

      <textarea id="inbox-pop-text" [ngModel]="inbox.draft()" (ngModelChange)="inbox.draft.set($event)" rows="4"
        maxlength="5200" [placeholder]="'inbox.popPlaceholder' | t" [attr.aria-label]="'inbox.write' | t"
        (keydown)="onKey($event)"></textarea>
      <p class="help">{{ (touch ? 'inbox.popHelpTouch' : 'inbox.popHelp') | t }}</p>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="discard()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !title()" (click)="save()">
          {{ 'inbox.save' | t }}</button>
      </div>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .pop { position: absolute; top: calc(100% + 12px); right: -8px; z-index: 52; width: min(380px, calc(100vw - 24px));
      box-sizing: border-box; padding: 14px; display: flex; flex-direction: column; gap: 10px;
      background: var(--surface); color: var(--text); border-radius: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
    /* 吹き出しのしっぽ（ペンを指す） */
    .pop::before { content: ''; position: absolute; top: -8px; right: 18px; width: 16px; height: 16px;
      background: var(--surface); transform: rotate(45deg); border-radius: 3px; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .h { font-size: 15px; font-weight: bold; }
    .all { font-size: 13px; color: var(--primary); text-decoration: none; white-space: nowrap; }
    .recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    /* タイトルも詳しいことも、15文字ほどで切って「…」 */
    .t { flex: none; max-width: 15em; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .b { min-width: 0; max-width: 15em; font-size: 11px; color: var(--text-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 4px 6px; font-size: 13px; color: var(--text-muted); }
    textarea { width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px 10px; border-radius: 8px; }
    .help { margin: -4px 0 0; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
    .error { margin: 0; color: var(--danger-text); font-size: 13px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; font-size: 14px; cursor: pointer; }
    .primary { min-height: 40px; padding: 0 18px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
    /* スマホ：画面の幅いっぱいで、ヘッダーのすぐ下に */
    @media (max-width: 600px) {
      .pop { position: fixed; top: 58px; left: 12px; right: 12px; width: auto; }
      .pop::before { display: none; }
    }
  `,
})
export class InboxPop implements OnInit {
  close = output<void>();
  protected inbox = inject(InboxService);
  readonly touch = IS_TOUCH;
  busy = signal(false);
  error = signal('');

  /** 1行目がタイトル（200字まで）、2行目からが詳しいこと */
  title = computed(() => splitMemo(this.inbox.draft()).title);
  private body = computed(() => splitMemo(this.inbox.draft()).body);
  /** 開いた時点の並び（直したメモが、開いている間に上へ跳ねないように） */
  private order = signal<string[] | null>(null);
  /** ピン止めが上。それぞれの中は、開いた時点の並び（直したメモは、bump で上へ） */
  recent = computed(() => pinnedStable(this.inbox.active(), this.order()).slice(0, 3));
  private appRef = inject(ApplicationRef);

  /** 直し終えたメモを、0.5秒待ってから、ピン止めしていない群の一番上へ、すーっと動かす（受信箱のページと同じ） */
  bump(id: string) {
    setTimeout(() => smoothly(this.appRef,
      () => this.order.update((o) => (o ? [id, ...o.filter((x) => x !== id)] : o))), 500);
  }

  ngOnInit() {
    this.order.set(this.inbox.active().map((m) => m.id));
    setTimeout(() => document.getElementById('inbox-pop-text')?.focus());
  }

  /** Enter で保存（変換の確定では保存しない）。Shift＋Enter・Ctrl＋Enter で改行。スマホの Enter は改行 */
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') return; // 閉じるのはヘッダーに任せる（書きかけは残す。開いていた ⋮ も一緒に閉じる）
    const next = enterKey(e, () => this.save(), true);
    if (next !== null) this.inbox.draft.set(next);
  }

  async save() {
    const title = this.title();
    if (!title || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.inbox.add(title, this.body());
      this.inbox.draft.set('');
      this.inbox.showFlash('inbox.saved');
      this.close.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** キャンセルだけは、書きかけを捨てる */
  discard() {
    this.inbox.draft.set('');
    this.close.emit();
  }
}