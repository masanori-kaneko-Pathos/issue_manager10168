import { Component, computed, input, output } from '@angular/core';
import { Role } from '../core/models';
import { Invitee } from './invite-picker';
import { TPipe } from '../i18n/i18n';

/**
 * 招待を送る前の確かめの画面（窓の中身だけ）。プロジェクト名と、役割ごとの宛先を並べる。
 * 招待の窓とプロジェクトの作成の窓で使う。送ったものは取り消せないので、間違いに気づける最後の場所
 */
@Component({
  selector: 'app-invite-confirm',
  imports: [TPipe],
  template: `
    <p class="lead">{{ 'invite.confirmLead' | t }}</p>
    <div>
      <p class="label">{{ 'invite.confirmProject' | t }}</p>
      <p class="proj">{{ projectName() }}</p>
    </div>
    @for (g of groups(); track g.role) {
      <div>
        <h3 class="role" [attr.data-r]="g.role">{{ 'roles.' + g.role | t }}<span class="n">{{ g.emails.length }}</span></h3>
        <ul class="mails">
          @for (e of g.emails; track e) { <li>{{ e }}</li> }
        </ul>
      </div>
    }
    <div class="row">
      <button type="button" class="link" [disabled]="busy()" (click)="back.emit()">{{ 'invite.confirmBack' | t }}</button>
      <button type="button" class="primary" [disabled]="busy()" (click)="ok.emit()">
        {{ okKey() | t: { n: '' + invitees().length } }}</button>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 12px; }
    .lead { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .label { margin: 0; font-size: 12px; color: var(--text-muted); }
    .proj { margin: 2px 0 0; font-size: 16px; font-weight: bold; overflow-wrap: anywhere; }
    .role { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; font-size: 13px; color: var(--text-secondary); }
    /* 管理者は強い権限なので、間違いに気づけるよう赤い文字 */
    .role[data-r='admin'] { color: var(--danger-text); }
    .n { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface-alt); }
    .mails { list-style: none; margin: 0; padding: 0; max-height: 200px; overflow: auto; }
    .mails li { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 14px; overflow-wrap: anywhere; }
  `,
})
export class InviteConfirm {
  projectName = input.required<string>();
  invitees = input.required<Invitee[]>();
  busy = input(false);
  /** 送るボタンの言葉（作成の窓では「作成して招待を送る」） */
  okKey = input('invite.confirmSend');
  back = output<void>();
  ok = output<void>();

  /** 役割ごとの宛先（強い順。0人の役割は出さない） */
  groups = computed(() => (['admin', 'member', 'viewer'] as Role[])
    .map((role) => ({ role, emails: this.invitees().filter((p) => p.role === role).map((p) => p.email) }))
    .filter((g) => g.emails.length));
}