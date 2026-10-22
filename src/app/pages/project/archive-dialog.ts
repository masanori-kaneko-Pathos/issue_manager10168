import { Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { ArchiveKind } from '../../core/models';
import { ProjectService } from '../../core/project/project.service';
import { ProjectContext } from './project-context';
import { TPipe, I18nService } from '../../i18n/i18n';
import { AuthService } from '../../core/auth/auth.service';

/** プロジェクトのアーカイブ。種類（完了／打ち切り）と理由を書いて確定する。課題のステータスは変えない */
@Component({
  selector: 'app-archive-dialog',
  imports: [FormsModule, TPipe],
  host: { '(document:keydown.escape)': 'cancel.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog narrow" role="dialog" aria-modal="true" [attr.aria-label]="'archive.title' | t">
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
    .help { font-size: 13px; }
    fieldset { display: flex; flex-direction: column; gap: 8px; }
    legend { margin-bottom: 4px; }
    .opt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--border);
      border-radius: 8px; cursor: pointer; }
    .opt:has(input:checked) { border-color: var(--primary); background: var(--primary-bg); }
    .opt input { margin-top: 3px; width: 18px; height: 18px; }
    .opt-body { display: flex; flex-direction: column; gap: 2px; }
    .opt-name { font-weight: bold; font-size: 14px; }
    .opt-help { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    textarea { font-weight: normal; }
  `,
})
export class ArchiveDialog implements OnInit {
  /** 最初から入れておく種類と理由（見本を終えるときに使う。どちらも書き換えられる） */
  presetKind = input<ArchiveKind>('completed');
  presetReason = input('');
  done = output<void>();
  cancel = output<void>();

  private ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private i18n = inject(I18nService);
  private authService = inject(AuthService);
  /** 見本のプロジェクトか（見本なら、どの入口から開いても、理由を最初から入れる） */
  private readonly isSample = !!this.ctx.project()?.sample;

  readonly kinds: ArchiveKind[] = ['completed', 'cancelled'];
  kind = signal<ArchiveKind>('completed');
  reason = '';
  busy = signal(false);
  error = signal('');
  /** 凍結される未完了の課題（解決済みも含む。かんばん・リストに出ているもの） */
  openCount = computed(() => this.ctx.openIssues().length);

  ngOnInit() {
    this.kind.set(this.presetKind());
    // 外から渡された理由がなくても、見本なら「イントロダクションを完了しました」を入れておく（書き換えられる）
    this.reason = this.presetReason() || (this.isSample ? this.i18n.t('sample.endReason') : '');
  }

  async confirm() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.archive(this.ctx.pid(), this.kind(), this.reason.trim(), auth.currentUser!.uid, this.ctx.role()!);
      // 見本を終えた＝イントロダクションは済んだ。あとでプロジェクトが0件に戻っても、ようこそは自動では出さない
      if (this.isSample && !this.authService.profile()?.introHidden) {
        this.authService.updateProfile({ introHidden: true })
          .catch((e) => console.warn('イントロダクションを終えたことを覚えられませんでした', e));
      }
      this.done.emit();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}