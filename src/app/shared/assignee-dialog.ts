import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { ConflictError, IssueService, conflictWho } from '../core/issue/issue.service';
import { UndoService } from '../core/undo/undo.service';
import { Issue, Member } from '../core/models';
import { I18nService, TPipe } from '../i18n/i18n';

/**
 * 担当者を変える窓（担当者別のかんばんで、別の人の列に落としたとき）。
 * 期限の窓と同じ形：前 → 後、理由（必須）、衝突したら最新を土台にやり直す、確定したら「元に戻す」
 */
@Component({
  selector: 'app-assignee-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <p class="sub">#{{ issue().number }} {{ issue().title }}</p>
      <h2>{{ 'assigneeDialog.title' | t }}</h2>

      <div class="change">
        <span class="from">{{ nameOf()(current().assigneeId) }}</span>
        <span aria-hidden="true">→</span>
        <strong>{{ nameOf()(to()) }}</strong>
      </div>

      <label class="field">{{ 'edit.reason' | t }}
        <textarea [(ngModel)]="reason" rows="3" maxlength="1000" [placeholder]="'edit.reasonHint' | t"></textarea>
      </label>

      @if (conflict(); as c) {
        @let w = who(c.latest);
        <div class="conflict" role="alert">
          <p>{{ w.key | t: w.params }}</p>
          <p>{{ (c.blocked ? 'conflict.closed' : 'conflict.retry') | t }}</p>
        </div>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !reason.trim() || !!conflict()?.blocked"
          (click)="confirm()">{{ 'workflow.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    .change { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px;
      background: var(--surface-alt); border-radius: 8px; font-size: 14px; }
    .from { color: var(--text-muted); text-decoration: line-through; }
    textarea { font-weight: normal; }
  `,
})
export class AssigneeDialog {
  issue = input.required<Issue>();
  /** 新しい担当者 */
  to = input.required<string>();
  pid = input.required<string>();
  /** 「だれが先に更新したか」の名前を引くため */
  members = input<Member[]>([]);
  /** 名前の引き方（抜けた人の名前も引けるように、プロジェクトの側から渡す） */
  nameOf = input.required<(uid: string) => string>();
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private undo = inject(UndoService);

  reason = '';
  busy = signal(false);
  error = signal('');
  /** 保存しようとしたら、ほかの人が先に更新していた（blocked＝クローズなどで、もう変えられない） */
  conflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 衝突のあとは、最新の課題を土台にする */
  private base = signal<Issue | null>(null);
  current = computed(() => this.base() ?? this.issue());

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  async confirm() {
    const uid = auth.currentUser!.uid;
    const base = this.current();
    const to = this.to();
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(null);
    try {
      await this.issueService.updateIssue(this.pid(), base, { assigneeId: to }, this.reason.trim(), uid, this.tz());
      // 落とし間違いに気づいたとき、すぐ戻せるように（戻したときは知らせない）
      this.undo.offer('undo.edited', { field: this.i18n.t('issue.assignee') }, () => this.issueService.undoEdit(
        this.pid(), base.id, { assigneeId: to }, { assigneeId: base.assigneeId }, this.i18n.t('undo.reason'),
        uid, this.tz()));
      this.done.emit();
    } catch (e) {
      if (e instanceof ConflictError) {
        const blocked = ['closed', 'deleted', 'merged'].includes(e.latest.status);
        if (!blocked) this.base.set(e.latest);
        this.conflict.set({ latest: e.latest, blocked });
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