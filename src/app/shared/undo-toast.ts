import { Component, inject } from '@angular/core';
import { UndoService } from '../core/undo/undo.service';
import { TPipe } from '../i18n/i18n';

/** 画面の下の「元に戻す」の知らせ。アプリの一番外側に1つだけ置く。Ctrl＋Z でも戻せる（赤S） */
@Component({
  selector: 'app-undo-toast',
  imports: [TPipe],
  host: { '(document:keydown)': 'onKey($event)', '[animate.leave]': "'im-out-dialog'" },
  template: `
    @if (undo.notice(); as n) {
      <div class="toast" role="status" (mouseenter)="undo.pause()" (mouseleave)="undo.resume()">
        <span>{{ n.key | t: n.params }}</span>
        @if (n.canUndo) {
          <button type="button" class="act" [disabled]="undo.busy()" (click)="undo.undo()">{{ 'undo.action' | t }}</button>
        }
        <button type="button" class="x" [attr.aria-label]="'undo.close' | t" (click)="undo.dismiss()">✕</button>
      </div>
    }
  `,
  styles: `
    .toast { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
      z-index: 210; display: flex; align-items: center; gap: 12px; max-width: calc(100vw - 32px);
      padding: 8px 8px 8px 18px; border-radius: 22px; background: var(--text); color: var(--surface);
      font-size: 14px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); }
    .act { min-height: 32px; padding: 0 12px; border: none; border-radius: 16px; background: none;
      color: var(--primary-bg); font-weight: bold; font-size: 14px; cursor: pointer; }
    .act:hover { background: rgba(255, 255, 255, 0.15); }
    .x { width: 32px; height: 32px; border: none; border-radius: 50%; background: none; color: inherit; cursor: pointer; }
  `,
})
export class UndoToast {
  protected undo = inject(UndoService);

  /** Ctrl＋Z（Mac は ⌘＋Z）。入力欄の中では、文字の取り消しとしてブラウザに任せる */
  onKey(e: KeyboardEvent) {
    if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    if (!this.undo.canUndo) return;
    e.preventDefault();
    this.undo.undo();
  }
}