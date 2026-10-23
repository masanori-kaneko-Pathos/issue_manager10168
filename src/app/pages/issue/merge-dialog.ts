import { Component, DestroyRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Unsubscribe } from 'firebase/firestore';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ConflictError, IssueService } from '../../core/issue/issue.service';
import { Issue } from '../../core/models';
import { issueMatches, rankOf, terms } from '../../core/search/match';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 統合：統合先を探して選び、理由を書いて確定する（元に戻せないので、最後にもう一度確かめる） */
@Component({
  selector: 'app-merge-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <h2>{{ 'merge.title' | t }}</h2>
      <p class="help">{{ 'merge.note' | t }}</p>

      @if (target(); as tg) {
        <div class="picked">
          <span>{{ 'merge.target' | t }}：<strong>#{{ tg.number }} {{ tg.title }}</strong></span>
          <button type="button" class="link" (click)="target.set(null)">{{ 'merge.change' | t }}</button>
        </div>
      } @else {
        <label class="field">{{ 'merge.target' | t }}
          <input type="search" [ngModel]="q()" (ngModelChange)="q.set($event)" autofocus
            [placeholder]="'merge.searchPlaceholder' | t" />
        </label>
        <div class="results">
          @for (r of results(); track r.id) {
            <button type="button" class="row" (click)="target.set(r)">
              <span class="num">#{{ r.number }}</span>
              <span class="t">{{ r.title }}</span>
              <span class="st">{{ 'status.' + r.status | t }}</span>
            </button>
          } @empty {
            @if (q().trim()) { <p class="help">{{ 'search.empty' | t }}</p> }
          }
        </div>
      }

      <label class="field">{{ 'merge.reason' | t }}
        <textarea [(ngModel)]="reason" rows="2" maxlength="1000" [placeholder]="'merge.reasonHint' | t"></textarea>
      </label>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="end">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !target() || !reason.trim()" (click)="submit()">
          {{ 'merge.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .help { font-size: 13px; }
    input, textarea { font-weight: normal; }
    .results { display: flex; flex-direction: column; max-height: min(45vh, 360px); overflow: auto; }
    /* この窓の .row は「候補の行」（基準の .row の右寄せを打ち消す） */
    .row { justify-content: flex-start; gap: 8px; min-height: 44px; padding: 4px 8px; border: none;
      border-bottom: 1px solid var(--border); background: none; text-align: left; font-size: 14px; cursor: pointer; }
    .row:hover { background: var(--surface-alt); }
    .num { color: var(--text-muted); font-size: 13px; }
    .t { flex: 1; overflow-wrap: anywhere; }
    .st { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--surface-muted); white-space: nowrap; }
    .picked { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 10px 12px;
      border-radius: 8px; background: var(--surface-alt); font-size: 14px; }
    .picked span { flex: 1; overflow-wrap: anywhere; }
    .end { display: flex; justify-content: flex-end; gap: 8px; }
  `,
})
export class MergeDialog implements OnInit {
  pid = input.required<string>();
  /** 統合元（開いた時点の課題） */
  issue = input.required<Issue>();
  /** 依頼から開いたときに、最初から選んでおく統合先と理由（赤AB：承認＝いつもの窓を、中身を入れて開く） */
  presetTarget = input<{ iid: string; number: number } | null>(null);
  presetReason = input('');
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);

  q = signal('');
  target = signal<Issue | null>(null);
  reason = '';
  busy = signal(false);
  error = signal('');
  /** このプロジェクトの未クローズの課題（見張るので、統合先がクローズされたらすぐ候補から消える） */
  private open = signal<Issue[]>([]);
  private stop: Unsubscribe | null = null;
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 候補：自分以外の未クローズで、探す言葉に合うもの（番号そのもの → タイトル → それ以外の順） */
  results = computed(() => {
    const ts = terms(this.q());
    if (!ts.length) return [];
    return this.open()
      .filter((i) => i.id !== this.issue().id && issueMatches(i, ts))
      .sort((a, b) => rankOf(a, ts) - rankOf(b, ts) || b.number - a.number)
      .slice(0, 20);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }

  ngOnInit() {
    this.reason = this.presetReason();
    this.stop = this.issueService.watchOpen(this.pid(), (list) => {
      this.open.set(list);
      // 依頼の統合先が、まだ未クローズで残っていれば選んでおく（クローズ済みなら、選び直してもらう）
      const p = this.presetTarget();
      if (p && !this.target()) this.target.set(list.find((i) => i.id === p.iid) ?? null);
    }, (e) => {
      console.error(e);
      this.error.set('common.loadError');
    });
  }

  async submit() {
    const tg = this.target();
    if (!tg) return;
    // 元に戻せない操作なので、最後にもう一度確かめる
    if (!window.confirm(this.i18n.t('merge.confirmAsk', { n: String(this.issue().number), to: String(tg.number) }))) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.issueService.mergeIssue(this.pid(), this.issue(), tg, this.reason.trim(), auth.currentUser!.uid, this.tz());
      this.done.emit();
    } catch (e) {
      if (e instanceof ConflictError) this.error.set('merge.conflict');
      else if ((e as Error).message === 'merge-target-closed') this.error.set('merge.targetClosed');
      else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }
}