import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../core/firebase';
import { AuthService } from '../core/auth/auth.service';
import { ConflictError, IssueService, conflictWho } from '../core/issue/issue.service';
import { CAUSE_CATEGORIES, CauseCategory, Effect, Issue, Member, hasWorkaround, toHours } from '../core/models';
import { Transition } from '../core/issue/workflow';
import { I18nService, TPipe } from '../i18n/i18n';
import { DraftService, fieldPlace } from '../core/draft/draft.service';

@Component({
  selector: 'app-status-dialog',
  imports: [FormsModule, TPipe],
  // 日本語の変換は、確定したときに ngModel の値が入る（その瞬間には input が来ない）ので、確定のときにもしまう
  host: {
    '(document:keydown.escape)': 'cancel.emit()', '(input)': 'stash()', '(compositionend)': 'stash()',
    '[animate.leave]': "'im-out-dialog'",
  },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
      <p class="sub">#{{ issue().number }} {{ issue().title }}</p>
      <h2>{{ 'workflow.' + transition().key | t }}</h2>

      @if (transition().needs === 'reason') {
        <label class="field">{{ 'workflow.reason' | t }}
          <textarea [(ngModel)]="reason" rows="3" [placeholder]="'workflow.reasonHint.' + transition().key | t"></textarea>
        </label>
      }
      @if (transition().needs === 'resolve') {
        <label class="field">{{ 'workflow.cause' | t }}
          <textarea [(ngModel)]="cause" rows="2"></textarea>
        </label>
        <label class="field">{{ 'workflow.countermeasure' | t }}
          <textarea [(ngModel)]="countermeasure" rows="2"></textarea>
        </label>
        <fieldset>
          <legend>{{ 'workflow.causeCategory' | t }}</legend>
          <div class="chips">
            @for (c of causeCategories; track c) {
              <button type="button" [class.on]="causeCategory() === c" (click)="causeCategory.set(c)">
                {{ 'causeCategories.' + c | t }}</button>
            }
          </div>
        </fieldset>
        @if (effort()) {
          <label class="field">{{ 'issue.actualHours' | t }}（{{ 'effort.optional' | t }}）
            <span class="hours">
              <input type="number" min="0" max="999" step="0.5" [(ngModel)]="actual" /> {{ 'effort.unit' | t }}</span>
          </label>
        }
        @if (needsWaCheck()) {
          <div class="criteria">
            <p class="help">{{ 'workaround.endedHelp' | t }}</p>
            <p class="pre">{{ current().workaround }}</p>
            <label class="check">
              <input type="checkbox" [checked]="waEnded()" (change)="waEnded.set(!waEnded())" />
              {{ 'workaround.endedCheck' | t }}
            </label>
          </div>
        }
        @if (openSubs()) { <p class="warn" role="status">{{ 'subtask.resolveOpen' | t: { n: '' + openSubs() } }}</p> }
        @if (openSplits()) { <p class="warn" role="status">{{ 'subtask.resolveSplits' | t: { n: '' + openSplits() } }}</p> }
      }
      @if (transition().needs === 'close') {
        <fieldset>
          <legend>{{ 'workflow.effect' | t }}</legend>
          <div class="chips">
            @for (e of effects; track e) {
              <button type="button" [class.on]="effect() === e" (click)="effect.set(e)">
                {{ 'workflow.effectOpts.' + e | t }}</button>
            }
          </div>
          @if (effect() === 'no') { <p class="help">{{ 'workflow.closeHintNo' | t }}</p> }
        </fieldset>
        <label class="field">{{ 'workflow.learning' | t }}
          <textarea [(ngModel)]="learning" rows="2"></textarea>
        </label>
      }
      @if (transition().needs === 'resolve' || transition().needs === 'close') {
        <div class="criteria">
          <p class="pre">{{ current().doneCriteria }}</p>
          <label class="check">
            <input type="checkbox" [checked]="doneMet()" (change)="doneMet.set(!doneMet())" />
            {{ 'workflow.doneCriteriaMet' | t }}
          </label>
        </div>
      }

      @if (conflict(); as c) {
        @let w = who(c.latest);
        <div class="conflict" role="alert">
          <p>{{ w.key | t: w.params }}</p>
          @if (c.blocked) {
            <p>{{ 'conflict.statusChanged' | t: { status: i18n.t('status.' + c.latest.status) } }}</p>
          } @else {
            <p>{{ 'conflict.retry' | t }}</p>
          }
        </div>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="discard()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !canConfirm() || !!conflict()?.blocked"
          (click)="confirm()">
          {{ 'workflow.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    .chips { margin-top: 4px; }
    .criteria { background: var(--surface-alt); padding: 12px; border-radius: 8px; }
    .check { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 44px; }
    .check input { width: 22px; height: 22px; }
    .hours { display: flex; align-items: center; gap: 6px; font-weight: normal; }
    .hours input { width: 120px; }
    `,
})
export class StatusDialog implements OnInit {
  issue = input.required<Issue>();
  /** 「だれが先に更新したか」の名前を引くため */
  members = input<Member[]>([]);
  transition = input.required<Transition>();
  pid = input.required<string>();
  /** 依頼から開いたときに、最初から入れておく理由（再開の依頼） */
  presetReason = input('');
  /** 工数がオンのプロジェクトか（解決するとき、実績の欄を出す） */
  effort = input(false);
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  readonly causeCategories = CAUSE_CATEGORIES;
  readonly effects: Effect[] = ['yes', 'partial', 'no'];

  reason = '';
  cause = '';
  countermeasure = '';
  learning = '';
  actual: number | null = null;
  causeCategory = signal<CauseCategory | null>(null);
  effect = signal<Effect | null>(null);
  doneMet = signal(false);
  /** 回避策を外したと確かめたか（解決済みにするとき、回避策が入っている課題だけ） */
  waEnded = signal(false);
  needsWaCheck = computed(() => this.transition().needs === 'resolve' && hasWorkaround(this.current()));
  busy = signal(false);
  error = signal('');
  /** 保存しようとしたら、ほかの人が先に更新していた（blocked なら、この操作はもうできない） */
  conflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 衝突のあとは、最新の課題を土台にする */
  private base = signal<Issue | null>(null);
  current = computed(() => this.base() ?? this.issue());
  /** 解決するときの注意：未完了のサブタスクと、切り出してまだ終わっていない課題の数（止めない・赤ペン5） */
  openSubs = signal(0);
  openSplits = signal(0);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  ngOnInit() {
    // 依頼から開いたときは依頼の理由、なければ書きかけ
    this.reason = this.presetReason() || this.drafts.getText(this.place('status:' + this.transition().key));
    // 書きかけがあればそれを、なければ対応中に書いた原因・対策を、最初から入れておく
    const i = this.issue();
    this.cause = this.drafts.getText(this.place('cause')) || (i.cause ?? '');
    this.countermeasure = this.drafts.getText(this.place('countermeasure')) || (i.countermeasure ?? '');
    this.learning = this.drafts.getText(this.place('learning'));
    this.causeCategory.set(i.causeCategory ?? null);
    this.actual = i.actualHours ?? null;
    if (this.transition().needs === 'resolve') this.loadSubtaskNote();
  }

  /** サブタスクを1回読んで、注意の件数を出す。読めなくても解決は止めない（注意が出ないだけ） */
  private async loadSubtaskNote() {
    try {
      const subs = await this.issueService.listSubtasks(this.pid(), this.issue().id);
      this.openSubs.set(subs.filter((s) => !s.splitTo && s.status !== 'done').length);
      const splits = await Promise.all(subs.filter((s) => s.splitTo)
        .map((s) => this.issueService.get(this.pid(), s.splitTo!.iid).catch(() => null)));
      this.openSplits.set(splits.filter((x) => x && ['open', 'in_progress', 'on_hold'].includes(x.status)).length);
    } catch (e) {
      console.error(e);
    }
  }

  canConfirm(): boolean {
    switch (this.transition().needs) {
      case 'reason': return !!this.reason.trim();
      case 'resolve': return !!(this.cause.trim() && this.countermeasure.trim() && this.causeCategory() && this.doneMet()
        && (!this.needsWaCheck() || this.waEnded())
        && (!this.effort() || toHours(this.actual) !== undefined));
      case 'close': return !!(this.effect() && this.doneMet());
      default: return true;
    }
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    this.conflict.set(null);
    try {
      await this.issueService.changeStatus(this.pid(), this.current(), this.transition(), {
        reason: this.reason.trim(),
        cause: this.cause.trim(),
        countermeasure: this.countermeasure.trim(),
        causeCategory: this.causeCategory(),
        effect: this.effect(),
        learning: this.learning.trim(),
        doneCriteriaMet: this.doneMet(),
        workaroundEnded: this.needsWaCheck() && this.waEnded(),
        actualHours: this.effort() && this.transition().needs === 'resolve' ? toHours(this.actual) ?? null : null,
      }, auth.currentUser!.uid, this.tz());
      this.clearDrafts();
      this.done.emit();
    } catch (e) {
      if (e instanceof ConflictError) {
        this.onConflict(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** ステータスが同じなら、最新を土台にしてやり直せる。変わっていたら、この操作はもうできない */
  private onConflict(latest: Issue) {
    const blocked = latest.status !== this.current().status;
    if (!blocked) this.base.set(latest);
    this.conflict.set({ latest, blocked });
  }

  private drafts = inject(DraftService);

  private place(slot: string) {
    return fieldPlace(this.pid(), this.issue().id, slot);
  }

  /** この窓で書く欄（名札と今の値）。理由は操作ごとに別、原因・対策・学びは詳細のパネルと同じ名札 */
  private fields(): [string, string][] {
    switch (this.transition().needs) {
      case 'reason': return [[this.place('status:' + this.transition().key), this.reason]];
      case 'resolve': return [[this.place('cause'), this.cause], [this.place('countermeasure'), this.countermeasure]];
      case 'close': return [[this.place('learning'), this.learning]];
      default: return [];
    }
  }

  /** 打つたびにしまう（入力は窓の外側まで上がってくるので、ここ1か所で受ける） */
  stash() {
    for (const [k, v] of this.fields()) this.drafts.setText(k, v);
  }

  private clearDrafts() {
    for (const [k] of this.fields()) this.drafts.clearText(k);
  }

  /** やめる：書きかけを捨てて閉じる */
  discard() {
    this.clearDrafts();
    this.cancel.emit();
  }

  who(latest: Issue) {
    return conflictWho(latest, this.members(), auth.currentUser!.uid);
  }
}