import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../core/project/project.service';
import { SearchService } from '../../core/search/search.service';
import { ProjectContext } from './project-context';
import { TPipe } from '../../i18n/i18n';

/** プロジェクトの完全な削除。元に戻せないので、プロジェクト名を打ち込んでから確定する */
@Component({
  selector: 'app-delete-project-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'busy() || cancel.emit()' },
  template: `
    <div class="backdrop" (click)="busy() || cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'deleteProject.title' | t">
      <h2>{{ 'deleteProject.title' | t }}</h2>
      <p class="warn">{{ 'deleteProject.warn' | t }}</p>
      @if (others() === null) {
        <p class="help">{{ 'deleteProject.membersUnknown' | t }}</p>
      } @else if (others()) {
        <p class="help">{{ 'deleteProject.members' | t: { n: '' + others() } }}</p>
      }
      <label class="field">{{ 'deleteProject.typeName' | t: { name: name() } }}
        <input [(ngModel)]="typed" autocomplete="off" />
      </label>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" [disabled]="busy()" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [disabled]="busy() || typed !== name()" (click)="confirm()">
          {{ 'deleteProject.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); width: min(480px, calc(100% - 32px));
      border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    h2 { font-size: 18px; margin: 0; }
    .warn { margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--danger-bg); color: var(--danger-text); }
    .help { margin: 0; font-size: 13px; color: var(--text-muted); }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: bold; }
    input { min-height: 44px; font-size: 16px; padding: 0 12px; font-weight: normal; }
    .error { color: var(--danger-text); margin: 0; }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; cursor: pointer; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--danger); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
  `,
})
export class DeleteProjectDialog {
  pid = input.required<string>();
  name = input.required<string>();
  /** 自分以外のメンバーの人数（知らせが届く人）。わからなければ null */
  others = input<number | null>(null);
  /** 消し終わった（移動や知らせは、呼んだ側が決める） */
  done = output<string>();
  cancel = output<void>();

  /** プロジェクトの中から開いたときだけある（見張りに「自分で消している」と伝えるため） */
  private ctx = inject(ProjectContext, { optional: true });
  private ps = inject(ProjectService);
  private search = inject(SearchService);

  typed = '';
  busy = signal(false);
  error = signal('');

  async confirm() {
    const name = this.name();
    if (this.typed !== name) return;
    this.busy.set(true);
    this.error.set('');
    // 消している最中に、見張りが「外された」と勘違いしてホームへ動かないよう、先に印を付ける
    this.ctx?.markDeleting(true);
    try {
      await this.ps.deleteProject(this.pid(), name);
      this.search.invalidate();
      this.done.emit(name);
    } catch (e) {
      console.error(e);
      this.ctx?.markDeleting(false);
      this.error.set('common.saveError');
      this.busy.set(false);
    }
  }
}