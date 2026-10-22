import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../core/project/project.service';
import { SearchService } from '../../core/search/search.service';
import { ProjectContext } from './project-context';
import { TPipe } from '../../i18n/i18n';

/** プロジェクトの完全な削除。元に戻せないので、プロジェクト名を打ち込んでから確定する */
@Component({
  selector: 'app-delete-project-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'busy() || cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="busy() || cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'deleteProject.title' | t">
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
        <button type="button" class="primary danger" [disabled]="busy() || typed !== name()" (click)="confirm()">
          {{ 'deleteProject.confirm' | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 元に戻せない操作なので、注意は黄ではなく赤 */
    .warn { background: var(--danger-bg); color: var(--danger-text); border-color: transparent; }
    .help { font-size: 13px; }
    input { font-weight: normal; }
  `,
})
export class DeleteProjectDialog implements OnInit {
  pid = input.required<string>();
  name = input.required<string>();
  /** 名前を最初から入れておく（見本のプロジェクト。確定を押すだけで消せる） */
  prefill = input(false);

  ngOnInit() {
    if (this.prefill()) this.typed = this.name();
  }
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