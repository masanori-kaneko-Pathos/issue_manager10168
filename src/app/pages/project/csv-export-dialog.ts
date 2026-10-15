import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { IssueService } from '../../core/issue/issue.service';
import { csvFileName, downloadText, issuesToCsv } from '../../core/issue/csv';
import { Issue } from '../../core/models';
import { Clock } from '../../core/time/clock';
import { I18nService, TPipe } from '../../i18n/i18n';
import { ProjectContext } from './project-context';

/** CSV の書き出し。範囲（リストの表示どおり／すべて）を選んでから書き出す */
@Component({
  selector: 'app-csv-export-dialog',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'csv.export' | t">
      <h2>{{ 'csv.export' | t }}</h2>

      <label class="opt" [class.off]="!listCount()">
        <input type="radio" name="scope" [checked]="scope() === 'list'" [disabled]="!listCount()"
          (change)="scope.set('list')" />
        <span class="opt-body">
          <span class="opt-name">{{ 'csv.scopeList' | t: { n: '' + listCount() } }}</span>
          <span class="opt-help">{{ (ctx.listView() ? 'csv.scopeListHelp' : 'csv.scopeListOff') | t }}</span>
        </span>
      </label>

      <label class="opt">
        <input type="radio" name="scope" [checked]="scope() === 'all'" (change)="scope.set('all')" />
        <span class="opt-body">
          <span class="opt-name">{{ 'csv.scopeAll' | t: { n: all() ? '' + all()!.length : '…' } }}</span>
          <span class="opt-help">{{ 'csv.scopeAllHelp' | t }}</span>
        </span>
      </label>

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="!chosen()?.length" (click)="confirm()">
          {{ 'csv.submit' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(460px, calc(100% - 32px));
      border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    h2 { font-size: 18px; margin: 0; }
    .opt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: 8px; cursor: pointer; }
    .opt:has(input:checked) { border-color: var(--primary); background: var(--primary-bg); }
    .opt.off { cursor: default; color: var(--text-disabled); }
    .opt input { margin-top: 3px; width: 18px; height: 18px; }
    .opt-body { display: flex; flex-direction: column; gap: 2px; }
    .opt-name { font-weight: bold; font-size: 14px; }
    .opt-help { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; cursor: pointer; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
  `,
})
export class CsvExportDialog implements OnInit {
  done = output<void>();
  cancel = output<void>();

  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  /** リストの表示の件数（リスト以外のタブにいるときは 0） */
  listCount = computed(() => this.ctx.listView()?.length ?? 0);
  /** リストで何か見えていれば「リストの表示どおり」、なければ「すべて」を選んだ状態で開く */
  scope = signal<'list' | 'all'>(this.ctx.listView()?.length ? 'list' : 'all');
  /** すべての課題（開いたときに1回だけ読む。読み終わるまで null） */
  all = signal<Issue[] | null>(null);
  error = signal('');
  /** 今の選択で書き出す課題 */
  chosen = computed(() => (this.scope() === 'list' ? this.ctx.listView() : this.all()));

  async ngOnInit() {
    try {
      // クローズ・却下は、ふだん見張っていないので、ここで1回だけ全部読む（削除フォルダの分は除く）
      this.all.set((await this.issueService.listAll(this.ctx.pid()))
        .filter((i) => i.status !== 'deleted')
        .sort((a, b) => a.number - b.number));
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    }
  }

  confirm() {
    const issues = this.chosen();
    if (!issues?.length) return;
    const now = this.clock.now();
    const tz = this.authService.profile()?.timeZone ?? 'Asia/Tokyo';
    const csv = issuesToCsv(issues, {
      t: (k) => this.i18n.t(k),
      nameOf: (uid) => this.ctx.nameOf(uid),
      labels: this.ctx.project()?.labels ?? [],
      tz,
      nowMs: now,
    });
    downloadText(csvFileName(this.ctx.project()?.name, now, tz), csv);
    this.done.emit();
  }
}