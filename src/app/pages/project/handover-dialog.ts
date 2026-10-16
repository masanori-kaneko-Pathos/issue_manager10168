import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Member, Role } from '../../core/models';
import { MemberChange, ProjectService } from '../../core/project/project.service';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';
import { MemberSelect } from '../../shared/member-select';

/** handover＝担当の引き継ぎだけ、remove＝外す、role＝閲覧者に変える、leave＝自分から抜ける */
export type HandoverMode = 'handover' | 'remove' | 'role' | 'leave';

/** 担当の引き継ぎ（外す・閲覧者に変える・抜けるときにも、先に引き継ぐ） */
@Component({
  selector: 'app-handover-dialog',
  imports: [FormsModule, TPipe, MemberSelect],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
      <h2>{{ 'handover.title.' + mode() | t: { name: target().displayName, role: i18n.t('roles.' + (role() ?? 'viewer')) } }}</h2>
      <p class="help">{{ 'handover.note.' + mode() | t }}</p>

      @if (issues().length) {
        <p class="label">{{ 'handover.issues' | t: { n: '' + issues().length } }}</p>
        <ul class="issues">
          @for (i of issues(); track i.id) {
            <li><span class="num">#{{ i.number }}</span> {{ i.title }}
              <span class="st">{{ 'status.' + i.status | t }}</span></li>
          }
        </ul>
        <div class="field">
          <label for="h-to">{{ 'handover.to' | t }}</label>
          <app-member-select selectId="h-to" placeholder="handover.choose" [members]="successors()" [value]="to()"
            (picked)="to.set($event)" />
        </div>
        <label class="field">{{ 'handover.reason' | t }}
          <textarea [(ngModel)]="reason" rows="2" [placeholder]="'handover.reasonHint' | t"></textarea>
        </label>
      } @else {
        <p class="none">{{ 'handover.none' | t }}</p>
      }

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [class.danger]="mode() === 'remove' || mode() === 'leave'"
          [disabled]="busy() || !ready()" (click)="confirm()">{{ 'handover.confirm.' + mode() | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(520px, calc(100% - 32px)); max-height: 90vh;
      overflow: auto; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    h2 { font-size: 18px; margin: 0; overflow-wrap: anywhere; }
    .help { margin: 0; font-size: 13px; color: var(--text-muted); }
    .label { margin: 0; font-size: 14px; font-weight: bold; }
    .issues { list-style: none; margin: 0; padding: 8px 12px; max-height: 180px; overflow: auto;
      background: var(--surface-alt); border-radius: 8px; font-size: 13px; }
    .issues li { padding: 4px 0; overflow-wrap: anywhere; }
    .num { color: var(--text-muted); }
    .st { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--surface-muted); }
    fieldset { border: none; padding: 0; margin: 0; }
    legend { font-size: 14px; font-weight: bold; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .chips button { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-strong); background: var(--surface);
      border-radius: 22px; font-size: 14px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    .none { margin: 0; font-size: 14px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; }
    .primary.danger { background: var(--danger); }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
  `,
})
export class HandoverDialog {
  mode = input.required<HandoverMode>();
  target = input.required<Member>();
  /** mode が role のときの、変えた先の役割 */
  role = input<Role | null>(null);
  done = output<void>();
  cancel = output<void>();

  private ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  to = signal<string | null>(null);
  reason = '';
  busy = signal(false);
  error = signal('');

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  /** 引き継ぐ課題：その人が担当している未完了の課題（置き場の見張りから読むので、読み直しは要らない） */
  issues = computed(() => this.ctx.openIssues()
    .filter((i) => i.assigneeId === this.target().uid)
    .sort((a, b) => a.number - b.number));
  /** 引き継げる人：本人以外の、管理者とメンバー（閲覧者は担当者になれない） */
  successors = computed(() => this.ctx.members().filter((m) => m.uid !== this.target().uid && m.role !== 'viewer'));

  /** 担当がなければすぐ押せる。あれば、引き継ぐ人と理由が必須 */
  ready() {
    return !this.issues().length || (!!this.to() && !!this.reason.trim());
  }

  async confirm() {
    const mode = this.mode();
    const change: MemberChange =
      mode === 'role' ? { kind: 'role', role: this.role()! }
      : mode === 'remove' ? { kind: 'remove' }
      : mode === 'leave' ? { kind: 'leave' }
      : null;
    this.busy.set(true);
    this.error.set('');
    // 自分から抜けるときは、見張りが「外された」と勘違いしないように、先に印を付ける
    if (mode === 'leave') this.ctx.markLeaving(true);
    try {
      await this.ps.changeMember(
        this.ctx.pid(), this.target(), this.issues().map((i) => i.id), this.to(), this.reason.trim(),
        change, auth.currentUser!.uid, this.tz(),
      );
      if (mode === 'remove') this.ctx.addFormer(this.target().uid, this.target().displayName);
      this.done.emit();
    } catch (e) {
      console.error(e);
      if (mode === 'leave') this.ctx.markLeaving(false);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}