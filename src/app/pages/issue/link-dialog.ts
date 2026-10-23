import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { IssueService } from '../../core/issue/issue.service';
import { SearchService } from '../../core/search/search.service';
import { Issue, IssueRelation, LINK_KINDS, LinkKind } from '../../core/models';
import { I18nService, TPipe } from '../../i18n/i18n';

/** 関連課題を追加する。種類を選んでから、課題を探して押す（押したらすぐ付く） */
@Component({
  selector: 'app-link-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="cancel.emit()">✕</button>
      <h2>{{ 'links.dialogTitle' | t }}</h2>
      <div class="chips" role="group">
        @for (k of kinds; track k) {
          <button type="button" [class.on]="kind() === k" [attr.aria-pressed]="kind() === k" (click)="kind.set(k)">
            {{ 'links.kinds.' + k | t }}</button>
        }
      </div>
      <p class="help">{{ 'links.kindHelp.' + kind() | t }}</p>
      <input type="search" [ngModel]="q()" (ngModelChange)="q.set($event)" autofocus
        [placeholder]="'links.searchPlaceholder' | t" />
      <div class="results">
        @for (g of results(); track g.project.id) {
          <p class="proj">{{ g.project.name }}</p>
          @for (r of g.results.slice(0, 10); track r.issue.id) {
            @let taken = isTaken(g.project.id, r.issue.id);
            <button type="button" class="row" [disabled]="taken || busy()" (click)="pick(g.project.id, r.issue)">
              <span class="num">#{{ r.issue.number }}</span>
              <span class="t">{{ r.issue.title }}</span>
              <span class="st">{{ taken ? ('links.already' | t) : ('status.' + r.issue.status | t) }}</span>
            </button>
          }
          @if (g.loading) { <p class="help">{{ 'common.loading' | t }}</p> }
        } @empty {
          @if (q().trim()) { <p class="help">{{ 'search.empty' | t }}</p> }
        }
      </div>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="end">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .results { display: flex; flex-direction: column; min-height: 120px; }
    .proj { margin: 8px 0 2px; font-size: 12px; color: var(--text-muted); font-weight: bold; }
    /* この窓の .row は「候補の行」（基準の .row の右寄せを打ち消す） */
    .row { justify-content: flex-start; gap: 8px; min-height: 44px; padding: 4px 8px; border: none;
      border-bottom: 1px solid var(--border); background: none; text-align: left; font-size: 14px; cursor: pointer; }
    .row:hover:not(:disabled) { background: var(--surface-alt); }
    .row:disabled { color: var(--text-disabled); cursor: default; }
    .num { color: var(--text-muted); font-size: 13px; }
    .t { flex: 1; overflow-wrap: anywhere; }
    .st { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--surface-muted); white-space: nowrap; }
    .end { display: flex; justify-content: flex-end; }
  `,
})
export class LinkDialog implements OnInit {
  pid = input.required<string>();
  iid = input.required<string>();
  number = input.required<number>();
  /** 今付いている関連課題（同じ種類で同じ相手は、2つ目を付けられないようにする） */
  relations = input<IssueRelation[]>([]);
  done = output<void>();
  cancel = output<void>();

  private issueService = inject(IssueService);
  private search = inject(SearchService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  readonly kinds = LINK_KINDS;
  kind = signal<LinkKind>('relates');
  q = signal('');
  busy = signal(false);
  error = signal('');
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** このプロジェクトを先頭に。この課題そのものは出さない */
  results = computed(() => this.search.find(this.q(), null)
    .map((g) => ({ ...g, results: g.results.filter((r) => !(g.project.id === this.pid() && r.issue.id === this.iid())) }))
    .filter((g) => g.loading || g.results.length)
    .sort((a, b) => Number(b.project.id === this.pid()) - Number(a.project.id === this.pid())));

  ngOnInit() {
    this.search.load();
  }

  /** 同じ種類で、同じ相手と、もうつながっているか（向きは問わない。互いに「完了待ち」も防ぐ） */
  isTaken(pid: string, iid: string) {
    return this.relations().some((r) => r.kind === this.kind() && r.pid === pid && r.iid === iid);
  }

  async pick(pid: string, issue: Issue) {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.issueService.addLink(this.pid(), this.iid(), this.number(), this.kind(),
        { pid, iid: issue.id, number: issue.number }, auth.currentUser!.uid, this.tz());
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}