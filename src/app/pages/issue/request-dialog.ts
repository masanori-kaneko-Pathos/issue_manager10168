import { Component, DestroyRef, OnInit, inject, input, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Unsubscribe } from 'firebase/firestore';
import { IssueService } from '../../core/issue/issue.service';
import { RequestService } from '../../core/request/request.service';
import { Issue, Member, RequestKind } from '../../core/models';
import { issueMatches, rankOf, terms } from '../../core/search/match';
import { TPipe } from '../../i18n/i18n';
import { DraftService, fieldPlace } from '../../core/draft/draft.service';

/** 依頼の窓（メンバー）：理由を書いて、管理者に頼む。統合のときは統合先も選ぶ */
@Component({
  selector: 'app-request-dialog',
  imports: [FormsModule, TPipe],
  // 日本語の変換は、確定したときに ngModel の値が入る（その瞬間には input が来ない）ので、確定のときにもしまう
  host: { '(document:keydown.escape)': 'cancel.emit()', '(input)': 'stash()', '(compositionend)': 'stash()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'request.title.' + kind() | t">
      <h2>{{ 'request.title.' + kind() | t }}</h2>
      <p class="sub">#{{ issue().number }} {{ issue().title }}</p>
      <p class="help">{{ 'request.note' | t }}</p>

      @if (kind() === 'merge') {
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
                <span class="num">#{{ r.number }}</span><span class="t">{{ r.title }}</span>
              </button>
            } @empty {
              @if (q().trim()) { <p class="help">{{ 'search.empty' | t }}</p> }
            }
          </div>
        }
      }

      <label class="field">{{ 'request.reason' | t }}
        <textarea [(ngModel)]="reason" rows="3" maxlength="1000" [placeholder]="'request.reasonHint.' + kind() | t"></textarea>
      </label>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="end">
        <button type="button" class="link" (click)="discard()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !reason.trim() || (kind() === 'merge' && !target())"
          (click)="send()">{{ 'request.send' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .sub { margin: 0; font-size: 13px; color: var(--text-muted); overflow-wrap: anywhere; }
    input, textarea { font-weight: normal; }
    .results { display: flex; flex-direction: column; max-height: min(45vh, 360px); overflow: auto; }
    /* この窓の .row は「候補の行」（基準の .row の右寄せを打ち消す） */
    .row { justify-content: flex-start; gap: 8px; min-height: 44px; padding: 4px 8px; border: none;
      border-bottom: 1px solid var(--border); background: none; text-align: left; font-size: 14px; cursor: pointer; }
    .row:hover { background: var(--surface-alt); }
    .num { color: var(--text-muted); font-size: 13px; }
    .t { flex: 1; overflow-wrap: anywhere; }
    .picked { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 10px 12px;
      border-radius: 8px; background: var(--surface-alt); font-size: 14px; }
    .picked span { flex: 1; overflow-wrap: anywhere; }
    .end { display: flex; justify-content: flex-end; gap: 8px; }
  `,
})
export class RequestDialog implements OnInit {
  pid = input.required<string>();
  issue = input.required<Issue>();
  kind = input.required<RequestKind>();
  /** 知らせる管理者を選ぶため */
  members = input.required<Member[]>();
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private requests = inject(RequestService);

  reason = '';
  busy = signal(false);
  error = signal('');
  q = signal('');
  target = signal<Issue | null>(null);
  /** 統合先の候補：このプロジェクトの未クローズ（統合の窓と同じ決まり。見張るので、クローズされたらすぐ消える） */
  private open = signal<Issue[]>([]);
  private stop: Unsubscribe | null = null;

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
    this.reason = this.drafts.getText(this.place());
    if (this.kind() !== 'merge') return; // 統合のときだけ、候補を見張る
    this.stop = this.issueService.watchOpen(this.pid(), (list) => this.open.set(list), (e) => {
      console.error(e);
      this.error.set('common.loadError');
    });
  }

  private drafts = inject(DraftService);
  /** 書きかけの名札（依頼の種類ごと） */
  private place = computed(() => fieldPlace(this.pid(), this.issue().id, 'request:' + this.kind()));

  stash() {
    this.drafts.setText(this.place(), this.reason);
  }

  /** やめる：書きかけを捨てて閉じる（外を押す・Esc は残す） */
  discard() {
    this.drafts.clearText(this.place());
    this.cancel.emit();
  }

  async send() {
    const tg = this.target();
    this.busy.set(true);
    this.error.set('');
    try {
      const admins = this.members().filter((m) => m.role === 'admin').map((m) => m.uid);
      await this.requests.create(this.pid(), this.issue(), this.kind(), this.reason.trim(),
      tg ? { iid: tg.id, number: tg.number } : null, admins);
      this.drafts.clearText(this.place());
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}