import { Component, inject, input, output } from '@angular/core';
import { AppNotification } from '../core/models';
import { NoticeOp } from '../core/notification/notification.service';
import { I18nService, TPipe } from '../i18n/i18n';

/**
 * お知らせ1件の操作（既読・未読／ピン止め／削除）のアイコン3つ。ベルの小窓とお知らせのページで共通。
 * いつ見せるか（乗せたときだけ、など）は、置く側が決める
 */
@Component({
  selector: 'app-notice-actions',
  imports: [TPipe],
  host: { role: 'group', '[attr.aria-label]': "i18n.t('notify.actions')" },
  template: `
    @let n = notice();
    <button type="button" class="ic" [title]="(n.read ? 'notify.markUnread' : 'notify.markRead') | t"
      [attr.aria-label]="(n.read ? 'notify.markUnread' : 'notify.markRead') | t" (click)="act.emit(n.read ? 'unread' : 'read')">
      @if (n.read) {
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" /></svg>
      } @else {
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7" /></svg>
      }
    </button>
    <button type="button" class="ic" [class.on]="n.pinned" [title]="(n.pinned ? 'notify.unpin' : 'notify.pin') | t"
      [attr.aria-label]="(n.pinned ? 'notify.unpin' : 'notify.pin') | t" (click)="act.emit(n.pinned ? 'unpin' : 'pin')">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" [attr.fill]="n.pinned ? 'currentColor' : 'none'"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg>
    </button>
    <button type="button" class="ic danger" [title]="'notify.delete' | t" [attr.aria-label]="'notify.delete' | t"
      (click)="act.emit('delete')">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
    </button>
  `,
  styles: `
    :host { display: inline-flex; gap: 2px; }
    .ic { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border: none; border-radius: 6px; background: none; color: var(--text-muted); cursor: pointer; }
    .ic:hover { background: var(--surface-muted); color: var(--text); }
    .ic.on { color: var(--primary); }
    .ic.danger:hover { color: var(--danger-text); }
  `,
})
export class NoticeActions {
  notice = input.required<AppNotification>();
  act = output<NoticeOp>();
  protected i18n = inject(I18nService);
}