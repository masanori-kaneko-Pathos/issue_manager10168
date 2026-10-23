import { Component, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { ProjectService } from '../../core/project/project.service';
import { Project, ProjectWithRole } from '../../core/models';
import { InvitePicker, Invitee, inviteErrorKey } from '../../shared/invite-picker';
import { TPipe } from '../../i18n/i18n';
import { shortName } from '../../core/text';
import { InviteConfirm } from '../../shared/invite-confirm';
import { HelpTip } from '../../shared/help-tip';

/**
 * 招待の窓。送れなかった人だけを残し、全員送れたら閉じる。
 * プロジェクトの中（メンバーのタブ）で開いたら、そのプロジェクトへ。
 * 外（ヘッダー）で開いたら、上に選び欄を出す（選べるのは、自分が管理者で、見本・アーカイブ中でないもの）
 */
@Component({
  selector: 'app-invite-dialog',
  imports: [FormsModule, TPipe, InvitePicker, InviteConfirm, HelpTip],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'invite.title' | t">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <h2>{{ 'invite.title' | t }}</h2>
      @if (confirming() && target(); as p) {
        <!-- 送る前の確かめ：送ったものは取り消せないので、宛先と役割をもう一度見せる -->
        <app-invite-confirm [projectName]="p.name" [invitees]="invitees()" [busy]="busy()"
          (back)="confirming.set(false)" (ok)="doSend()" />
      } @else {
        @if (loading()) {
          <p class="help">{{ 'common.loading' | t }}</p>
        } @else if (!choices().length) {
          <p class="warn">{{ 'invite.noProject' | t }}</p>
        } @else {
          <div class="field">
            <span class="field-head">{{ 'issueNew.project' | t }}
              <app-help-tip [keys]="['invite.whichProjects']" /></span>
            <select [ngModel]="chosen()" (ngModelChange)="chosen.set($event)" [attr.aria-label]="'issueNew.project' | t">
              @if (!chosen()) { <option value="" disabled>{{ 'invite.pickProject' | t }}</option> }
              @for (p of choices(); track p.id) { <option [value]="p.id" [title]="p.name">{{ short(p.name) }}</option> }
            </select>
          </div>
        }
        @if (retry()) { <p class="warn" role="status">{{ 'invite.retryNote' | t }}</p> }
        @if (hasFailed()) { <p class="warn" role="alert">{{ 'invite.someFailed' | t }}</p> }
        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        <app-invite-picker [(value)]="invitees" [failed]="failed()" />
        <div class="row">
          <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
          <button type="button" class="primary" [disabled]="busy() || !target()" (click)="askConfirm()">
            {{ 'invite.submit' | t: { n: '' + invitees().length } }}</button>
        </div>
      }
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 3列の表が入るように広い窓 */
    .dialog { width: min(720px, calc(100% - 32px)); }
    .field select { width: 100%; max-width: 100%; }
    .field-head { display: inline-flex; align-items: center; gap: 4px; }
    @media (max-width: 600px) { .dialog { width: 100%; } }
  `,
})
export class InviteDialog implements OnInit {
  /** 最初から入れておく人（作成のときに送れなかった人など） */
  initial = input<Invitee[]>([]);
  /** 作成のときに送れなかった人を、もう一度送るために開いたか */
  retry = input(false);
  /** 外（ヘッダー）から開いたとき、今いるプロジェクト（あれば、最初に選んでおく） */
  pid = input<string | null>(null);
  /** 1人でも送れたとき（招待中の一覧を読み直すため） */
  sent = output<void>();
  /** 全員送れて閉じるとき */
  done = output<void>();
  cancel = output<void>();

  private ps = inject(ProjectService);
  private picker = viewChild(InvitePicker);

  invitees = signal<Invitee[]>([]);
  failed = signal<Record<string, string>>({});
  busy = signal(false);
  error = signal('');
  hasFailed = () => Object.keys(this.failed()).length > 0;

  /** 外から開いたときの選び欄 */
  choices = signal<ProjectWithRole[]>([]);
  chosen = signal('');
  loading = signal(false);

  /** 送る先のプロジェクト */
  target = computed<Project | null>(() => this.choices().find((p) => p.id === this.chosen()) ?? null);

  async ngOnInit() {
    this.invitees.set(this.initial());
    this.loading.set(true);
    try {
      const list = (await this.ps.listMyProjects(auth.currentUser!.uid))
        .filter((p) => p.role === 'admin' && !p.archived && !p.sample && !p.deleting);
      this.choices.set(list);
      // 今いるプロジェクトを選んでおく。招待できないプロジェクトにいるときは、選んでもらう（1つだけなら、それ）
      const want = this.pid();
      this.chosen.set(list.find((p) => p.id === want)?.id ?? (list.length === 1 ? list[0].id : ''));
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  short(name: string) {
    return shortName(name);
  }

  /** 送る前に確かめるか（確かめの画面を出しているか） */
  confirming = signal(false);

  /** 「招待を送る」：欄の打ちかけを札にしてから、確かめの画面へ（まだ送らない） */
  askConfirm() {
    if (!this.target() || !this.picker()?.flush() || !this.invitees().length) return;
    this.confirming.set(true);
  }

  /** 確かめの画面の「送る」：ここで初めて送る */
  async doSend() {
    const project = this.target();
    const list = this.invitees();
    if (!project || !list.length) return;
    this.busy.set(true);
    const user = auth.currentUser!;
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
    // 送れなかった人がいれば、入力の画面に戻して理由の札を見せる
    this.confirming.set(false);
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