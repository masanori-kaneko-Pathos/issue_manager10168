import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { InboxService } from '../core/inbox/inbox.service';
import { UndoService } from '../core/undo/undo.service';
import { IS_TOUCH, enterKey } from '../core/dom';
import { TPipe } from '../i18n/i18n';

/**
 * ペンの吹き出し。上に最近のメモを3つ、下に書く欄。
 * 欄は1つで、1行目がタイトル・2行目から詳しいこと。Enter で受信箱に入れる（Shift＋Enter で改行）
 */
@Component({
  selector: 'app-inbox-pop',
  imports: [FormsModule, RouterLink, TPipe],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="pop" role="dialog" [attr.aria-label]="'inbox.write' | t">
      <div class="head">
        <span class="h">{{ 'inbox.recent' | t }}</span>
        <a routerLink="/inbox" class="all" (click)="close.emit()">{{ 'inbox.seeAll' | t: { n: '' + inbox.count() } }}</a>
      </div>
      <ul class="recent">
        @for (m of inbox.active().slice(0, 3); track m.id) {
          <li class="m-row">
            <a [routerLink]="['/inbox', m.id]" (click)="close.emit()">
              <span class="t">{{ m.title }}</span>
              @if (m.body) { <span class="b">{{ firstLine(m.body) }}</span> }
            </a>
            <button type="button" class="m-more" [attr.aria-label]="'inbox.memoMenu' | t" [title]="'inbox.memoMenu' | t"
              [attr.aria-expanded]="menuFor() === m.id" (click)="toggleMenu(m.id, $event)">⋮</button>
            @if (menuFor() === m.id) {
              <div class="m-backdrop" (click)="menuFor.set(null)"></div>
              <div class="m-menu" role="menu" [class.left]="menuLeft()">
                <a role="menuitem" [routerLink]="['/new']" [queryParams]="{ memo: m.id }" (click)="close.emit()">
                  {{ 'inbox.toIssue' | t }}</a>
                <a role="menuitem" [routerLink]="['/inbox', m.id]" (click)="close.emit()">{{ 'inbox.edit' | t }}</a>
                <button type="button" role="menuitem" class="danger" (click)="remove(m.id)">
                  {{ 'inbox.popDelete' | t }}</button>
              </div>
            }
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
    .m-row { position: relative; display: flex; align-items: center; gap: 2px; }
    .m-row > a { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; min-height: 30px;
      padding: 4px 6px; border-radius: 6px; color: var(--text); text-decoration: none; }
    .m-row > a:hover { background: var(--surface-alt); }
    .m-more { flex: none; width: 28px; height: 28px; border: none; border-radius: 6px; background: none;
      color: var(--text-muted); font-size: 16px; cursor: pointer; }
    .m-more:hover { background: var(--surface-alt); }
    .m-backdrop { position: fixed; inset: 0; z-index: 1; }
    /* ⋮ の横に出す（下の行にはかぶさらない）。右に空きがなければ左に */
    .m-menu { position: absolute; top: 0; left: calc(100% + 4px); z-index: 2; min-width: 160px; padding: 6px 0;
      display: flex; flex-direction: column; background: var(--surface); border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2); }
    .m-menu.left { left: auto; right: 32px; }
    .m-menu a, .m-menu button { display: block; text-align: left; padding: 0 16px; min-height: 38px; line-height: 38px;
      background: none; border: none; color: var(--text); text-decoration: none; font-size: 13px; cursor: pointer; }
    .m-menu a:hover, .m-menu button:hover { background: var(--surface-alt); }
    .m-menu .danger { color: var(--danger-text); }
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
  private undo = inject(UndoService);
  /** ⋮ を開いているメモ */
  menuFor = signal<string | null>(null);
  /** メニューを ⋮ の左に出すか（右に空きがないとき） */
  menuLeft = signal(false);

  toggleMenu(id: string, e: MouseEvent) {
    if (this.menuFor() === id) {
      this.menuFor.set(null);
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 右に、メニュー（約170px）が入る空きがあるか
    this.menuLeft.set(window.innerWidth - r.right < 180);
    this.menuFor.set(id);
  }

  /** ゴミ箱に移す（30日で自動で消える）。下に「元に戻す」を出す */
  async remove(id: string) {
    this.menuFor.set(null);
    try {
      await this.inbox.discard(id);
      this.undo.offer('inbox.discarded', undefined, () => this.inbox.restore(id));
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }


  /** 1行目がタイトル（200字まで）、2行目からが詳しいこと */
  title = computed(() => this.inbox.draft().split('\n')[0].trim().slice(0, 200));
  private body = computed(() => this.inbox.draft().split('\n').slice(1).join('\n').trim().slice(0, 5000));

  ngOnInit() {
    setTimeout(() => document.getElementById('inbox-pop-text')?.focus());
  }

  firstLine(body: string) {
    return body.split('\n')[0];
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