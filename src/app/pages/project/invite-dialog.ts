import { Component, OnInit, inject, input, output, signal, viewChild } from '@angular/core';
import { auth } from '../../core/firebase';
import { ProjectService } from '../../core/project/project.service';
import { InvitePicker, Invitee, inviteErrorKey } from '../../shared/invite-picker';
import { ProjectContext } from './project-context';
import { TPipe } from '../../i18n/i18n';

/** メンバーのタブから開く招待。送れなかった人だけを残し、全員送れたら閉じる */
@Component({
  selector: 'app-invite-dialog',
  imports: [TPipe, InvitePicker],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'invite.title' | t">
      <h2>{{ 'invite.title' | t }}</h2>
      @if (retry()) { <p class="warn" role="status">{{ 'invite.retryNote' | t }}</p> }
      @if (hasFailed()) { <p class="warn" role="alert">{{ 'invite.someFailed' | t }}</p> }
      <app-invite-picker [(value)]="invitees" [failed]="failed()" />
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy()" (click)="send()">
          {{ 'invite.submit' | t: { n: '' + invitees().length } }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 3列の表が入るように広い窓 */
    .dialog { width: min(720px, calc(100% - 32px)); }
    @media (max-width: 600px) { .dialog { width: 100%; } }
  `,
})
export class InviteDialog implements OnInit {
  /** 最初から入れておく人（作成のときに送れなかった人など） */
  initial = input<Invitee[]>([]);
  /** 作成のときに送れなかった人を、もう一度送るために開いたか */
  retry = input(false);
  /** 1人でも送れたとき（招待中の一覧を読み直すため） */
  sent = output<void>();
  /** 全員送れて閉じるとき */
  done = output<void>();
  cancel = output<void>();

  private ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private picker = viewChild(InvitePicker);

  invitees = signal<Invitee[]>([]);
  failed = signal<Record<string, string>>({});
  busy = signal(false);
  hasFailed = () => Object.keys(this.failed()).length > 0;

  ngOnInit() {
    this.invitees.set(this.initial());
  }

  async send() {
    if (!this.picker()?.flush()) return;
    const list = this.invitees();
    if (!list.length) return;
    this.busy.set(true);
    const user = auth.currentUser!;
    const project = this.ctx.project()!;
    const results = await Promise.allSettled(list.map((p) => this.ps.invite(project, p.email, p.role, user)));
    const left: Invitee[] = [];
    const why: Record<string, string> = {};
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(r.reason);
        left.push(list[i]);
        why[list[i].email] = inviteErrorKey(r.reason);
      }
    });
    this.busy.set(false);
    if (left.length < list.length) this.sent.emit();
    if (!left.length) {
      this.done.emit();
      return;
    }
    // 送れなかった人だけを残し、理由を札に出す
    this.invitees.set(left);
    this.failed.set(why);
  }
}