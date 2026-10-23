import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ConflictError, IssueService, conflictWho } from '../../core/issue/issue.service';
import { Issue, Member } from '../../core/models';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 課題の削除（削除フォルダへ）。理由は必須。依頼から開いたときは、依頼の理由を最初から入れておく */
@Component({
  selector: 'app-delete-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'delete.title' | t">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <h2>{{ 'delete.title' | t }}</h2>
      <p class="sub">#{{ current().number }} {{ current().title }}</p>
      <p class="help">{{ 'delete.note' | t }}</p>
      <label class="field">{{ 'delete.reason' | t }}
        <textarea [(ngModel)]="reason" rows="3" maxlength="1000" autofocus [placeholder]="'delete.reasonHint' | t"></textarea>
      </label>
      @if (conflict(); as c) {
        @let w = who(c);
        <div class="conflict" role="alert">
          <p>{{ w.key | t: w.params }}</p>
          <p>{{ (c.status === 'deleted'
            ? ('conflict.statusChanged' | t: { status: i18n.t('status.deleted') })
            : ('conflict.retry' | t)) }}</p>
        </div>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary danger" [disabled]="busy() || !reason.trim() || conflict()?.status === 'deleted'"
          (click)="confirm()">{{ 'delete.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    textarea { font-weight: normal; }
  `,
})
export class DeleteDialog implements OnInit {
  pid = input.required<string>();
  /** 開いた時点の課題 */
  issue = input.required<Issue>();
  members = input<Member[]>([]);
  /** 依頼から開いたときに、最初から入れておく理由 */
  presetReason = input('');
  /** 削除できた（課題の番号。リストの「元に戻す」の知らせに使う） */
  done = output<number>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  reason = '';
  busy = signal(false);
  error = signal('');
  /** 保存しようとしたら、ほかの人が先に更新していた（最新の課題） */
  conflict = signal<Issue | null>(null);
  /** 衝突のあとは、最新の課題を土台にする */
  private base = signal<Issue | null>(null);
  current = computed(() => this.base() ?? this.issue());
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  ngOnInit() {
    this.reason = this.presetReason();
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(null);
    try {
      await this.issueService.deleteIssue(this.pid(), this.current(), this.reason.trim(), auth.currentUser!.uid, this.tz());
      this.done.emit(this.current().number);
    } catch (e) {
      if (e instanceof ConflictError) {
        // まだ削除されていなければ、最新を土台にもう一度押せる。もう削除されていたら、押せなくする
        this.base.set(e.latest);
        this.conflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  who(latest: Issue) {
    return conflictWho(latest, this.members(), auth.currentUser!.uid);
  }
}