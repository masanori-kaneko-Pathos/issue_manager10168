import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { ConflictError, IssueService, conflictWho } from '../core/issue/issue.service';
import { UndoService } from '../core/undo/undo.service';
import { Issue, Member } from '../core/models';
import { formatDateTime, toLocalInput, zonedTime } from '../core/time/time';
import { I18nService, TPipe } from '../i18n/i18n';

@Component({
  selector: 'app-due-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
      <p class="sub">#{{ issue().number }} {{ issue().title }}</p>
      <h2>{{ 'dueDialog.title' | t }}</h2>

      <div class="change">
        <span class="from">{{ fromLabel() }}</span>
        <span aria-hidden="true">→</span>
        <strong>{{ toLabel() }}</strong>
      </div>

      <label class="field">{{ 'dueDialog.time' | t }}
        <input type="time" [ngModel]="time()" (ngModelChange)="time.set($event)" />
      </label>

      @if (isPast()) {
        <p class="warn" role="alert">{{ 'dueDialog.pastWarning' | t }}</p>
      }

      <label class="field">{{ 'edit.reason' | t }}
        <textarea [(ngModel)]="reason" rows="3" [placeholder]="'edit.reasonHint' | t"></textarea>
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
        <button type="button" class="primary" [class.past]="isPast()"
          [disabled]="busy() || !reason.trim() || !newDue() || !!conflict()?.blocked" (click)="confirm()">
          {{ (isPast() ? 'dueDialog.confirmPast' : 'workflow.confirm') | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(440px, calc(100% - 32px));
      border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    h2 { font-size: 18px; margin: 0; }
    .change { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px;
      background: var(--surface-alt); border-radius: 8px; font-size: 14px; }
    .from { color: var(--text-muted); text-decoration: line-through; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    input, textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    input { min-height: 44px; }
    .warn { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary);
      border: none; border-radius: 8px; font-size: 14px; }
    .primary.past { background: var(--danger); }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
    .conflict { padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .conflict p { margin: 0 0 4px; }
    .conflict p:last-child { margin-bottom: 0; }
  `,
})
export class DueDialog implements OnInit {
  issue = input.required<Issue>();
  /** 「だれが先に更新したか」の名前を引くため */
  members = input<Member[]>([]);
  /** 落とした日（'YYYY-MM-DD'、見ている人のタイムゾーンでの日付） */
  date = input.required<string>();
  pid = input.required<string>();
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private undo = inject(UndoService);

  time = signal('23:59');
  reason = '';
  busy = signal(false);
  error = signal('');
  /** 保存しようとしたら、ほかの人が先に更新していた（blocked＝クローズされて、もう変えられない） */
  conflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 衝突のあとは、最新の課題を土台にする */
  private base = signal<Issue | null>(null);
  current = computed(() => this.base() ?? this.issue());

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 落とした日 ＋ 時刻 を、見ている人のタイムゾーンの時刻として、1つの瞬間にする */
  newDue = computed(() => {
    const [y, m, d] = this.date().split('-').map(Number);
    const t = this.time().match(/^(\d{2}):(\d{2})$/);
    return t ? zonedTime(y, m, d, +t[1], +t[2], this.tz()) : null;
  });

  /** 過去の日時か（止めずに、注意を出すだけ） */
  isPast = computed(() => {
    const d = this.newDue();
    return !!d && d.getTime() <= Date.now();
  });

  fromLabel = computed(() => formatDateTime(this.current().dueAt.toDate(), this.tz(), this.i18n.lang()));
  toLabel = computed(() => {
    const d = this.newDue();
    return d ? formatDateTime(d, this.tz(), this.i18n.lang()) : '—';
  });

  ngOnInit() {
    // 元の期限の時刻（見ている人のタイムゾーンでの時:分）を、最初から入れておく
    this.time.set(toLocalInput(this.issue().dueAt.toDate(), this.tz()).slice(11));
  }

  async confirm() {
    const due = this.newDue();
    if (!due) return;
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(null);
    const base = this.current();
    try {
      await this.issueService.updateIssue(
        this.pid(), base, { dueAt: due }, this.reason.trim(), auth.currentUser!.uid, this.tz(),
      );
      // ドラッグの落とし間違いに気づいたとき、すぐ戻せるように
      this.undo.offer('undo.edited', { field: this.i18n.t('issue.due') }, () => this.issueService.undoEdit(
        this.pid(), base.id, { dueAt: due }, { dueAt: base.dueAt.toDate() }, this.i18n.t('undo.reason'),
        auth.currentUser!.uid, this.tz()));
      this.done.emit();
    } catch (e) {
      if (e instanceof ConflictError) {
        const blocked = e.latest.status === 'closed';
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