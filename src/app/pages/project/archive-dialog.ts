import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { ArchiveKind } from '../../core/models';
import { ProjectService } from '../../core/project/project.service';
import { ProjectContext } from './project-context';
import { TPipe } from '../../i18n/i18n';

/** プロジェクトのアーカイブ。種類（完了／打ち切り）と理由を書いて確定する。課題のステータスは変えない */
@Component({
  selector: 'app-archive-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()' },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'archive.title' | t">
      <h2>{{ 'archive.title' | t }}</h2>
      <p class="help">{{ 'archive.note' | t }}</p>
      <fieldset>
        <legend>{{ 'archive.kind' | t }}</legend>
        @for (k of kinds; track k) {
          <label class="opt">
            <input type="radio" name="kind" [checked]="kind() === k" (change)="kind.set(k)" />
            <span class="opt-body">
              <span class="opt-name">{{ 'archive.kinds.' + k | t }}</span>
              <span class="opt-help">{{ 'archive.kindHelp.' + k | t }}</span>
            </span>
          </label>
        }
      </fieldset>
      <label class="field">{{ 'archive.reason' | t }}
        <textarea [(ngModel)]="reason" rows="2" maxlength="1000" [placeholder]="'archive.reasonHint.' + kind() | t"></textarea>
      </label>
      @if (openCount()) { <p class="warn">{{ 'archive.openCount' | t: { n: '' + openCount() } }}</p> }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || !reason.trim()" (click)="confirm()">
          {{ 'archive.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(480px, calc(100% - 32px)); max-height: 90vh;
      overflow: auto; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    h2 { font-size: 18px; margin: 0; }
    .help { margin: 0; font-size: 13px; color: var(--text-muted); }
    fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    legend { font-size: 14px; font-weight: bold; margin-bottom: 4px; }
    .opt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: 8px; cursor: pointer; }
    .opt:has(input:checked) { border-color: var(--primary); background: var(--primary-bg); }
    .opt input { margin-top: 3px; width: 18px; height: 18px; }
    .opt-body { display: flex; flex-direction: column; gap: 2px; }
    .opt-name { font-weight: bold; font-size: 14px; }
    .opt-help { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    textarea { font-size: 16px; padding: 8px 12px; font-weight: normal; }
    .warn { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; cursor: pointer; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
  `,
})
export class ArchiveDialog {
  done = output<void>();
  cancel = output<void>();

  private ctx = inject(ProjectContext);
  private ps = inject(ProjectService);

  readonly kinds: ArchiveKind[] = ['completed', 'cancelled'];
  kind = signal<ArchiveKind>('completed');
  reason = '';
  busy = signal(false);
  error = signal('');
  /** 凍結される未完了の課題（解決済みも含む。かんばん・リストに出ているもの） */
  openCount = computed(() => this.ctx.openIssues().length);

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.archive(this.ctx.pid(), this.kind(), this.reason.trim(), auth.currentUser!.uid, this.ctx.role()!);
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}