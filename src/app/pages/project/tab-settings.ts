import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  LABEL_COLORS, Label, LabelColor, MAX_LABELS_PER_PROJECT, labelColor,
} from '../../core/models';
import { ProjectContext } from './project-context';
import { ProjectService } from '../../core/project/project.service';
import { HelpTip } from '../../shared/help-tip';
import { LabelChip } from '../../shared/label-chip';
import { I18nService, TPipe } from '../../i18n/i18n';

@Component({
  selector: 'app-tab-settings',
  imports: [FormsModule, TPipe, HelpTip, LabelChip],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    @if (ctx.role() !== 'admin') {
      <p>{{ 'projectSettings.adminOnly' | t }}</p>
    } @else {
      <section>
        <h2>{{ 'projectSettings.labels' | t }} <app-help-tip [keys]="['projectSettings.labelsHelp']" /></h2>
        <ul class="labels">
          @for (l of labels(); track l.id; let i = $index) {
            <li>
              <app-label-chip [label]="l" />
              <input [ngModel]="l.name" (ngModelChange)="rename(i, $event)" maxlength="20"
                [attr.aria-label]="'projectSettings.labelName' | t" />
              <div class="colors">
                @for (c of colors; track c) {
                  <button type="button" class="swatch" [attr.data-color]="c" [class.on]="colorOf(l) === c"
                    [attr.aria-label]="'projectSettings.colors.' + c | t" (click)="recolor(i, c)"></button>
                }
              </div>
              <button type="button" class="link danger" (click)="remove(i)">{{ 'projectSettings.delete' | t }}</button>
            </li>
          }
        </ul>

        @if (labels().length < max) {
          <form class="add" (ngSubmit)="add()">
            <input name="newLabel" [(ngModel)]="newName" maxlength="20" [placeholder]="'projectSettings.newLabel' | t" />
            <button type="submit" [disabled]="!newName.trim()">{{ 'projectSettings.add' | t }}</button>
          </form>
        } @else {
          <p class="help">{{ 'projectSettings.maxReached' | t: { n: '' + max } }}</p>
        }
        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        @if (info()) { <p class="ok">{{ info() | t }}</p> }
      </section>

      @if (dirty()) {
        <div class="savebar" role="status">
          <span>{{ 'settings.unsaved' | t }}</span>
          <button type="button" class="link" [disabled]="busy()" (click)="discard()">{{ 'settings.discard' | t }}</button>
          <button type="button" class="primary" [disabled]="busy()" (click)="save()">{{ 'settings.saveChanges' | t }}</button>
        </div>
      }
    }
  `,
  styles: `
    h2 { font-size: 16px; }
    .labels { list-style: none; padding: 0; margin: 0 0 12px; }
    .labels li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0;
      border-bottom: 1px solid var(--border); }
    .labels input { flex: 1; min-width: 140px; min-height: 40px; font-size: 16px; padding: 0 10px; }
    .colors { display: flex; gap: 6px; }
    .swatch { width: 28px; height: 28px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
    .swatch.on { border-color: var(--text); }
    .swatch[data-color='blue']   { background: var(--label-blue); }
    .swatch[data-color='green']  { background: var(--label-green); }
    .swatch[data-color='orange'] { background: var(--label-orange); }
    .swatch[data-color='red']    { background: var(--label-red); }
    .swatch[data-color='purple'] { background: var(--label-purple); }
    .swatch[data-color='gray']   { background: var(--label-gray); }
    .add { display: flex; gap: 8px; max-width: 480px; }
    .add input { flex: 1; min-height: 44px; font-size: 16px; padding: 0 12px; }
    .add button { min-height: 44px; padding: 0 16px; }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; cursor: pointer; }
    .danger { color: var(--danger-text); }
    .help { font-size: 12px; color: var(--text-muted); }
    .error { color: var(--danger-text); }
    .ok { color: var(--success-text); }
    .savebar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px; margin: 16px -16px 0; background: var(--warning-bg); border-top: 1px solid var(--warning-border); }
    .savebar span { flex: 1; font-size: 13px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary);
      border: none; border-radius: 8px; }
  `,
})
export class ProjectSettings implements OnInit {
  protected ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private i18n = inject(I18nService);

  readonly colors = LABEL_COLORS;
  readonly max = MAX_LABELS_PER_PROJECT;

  /** 画面で編集中のラベル */
  labels = signal<Label[]>([]);
  /** 保存済みのラベル（変更があるかの比較用） */
  private saved = signal<Label[]>([]);
  newName = '';
  busy = signal(false);
  error = signal('');
  info = signal('');

  dirty = computed(() => JSON.stringify(this.labels()) !== JSON.stringify(this.saved()));

  ngOnInit() {
    // 色が未設定の古いラベルにも、表示どおりの色を入れておく
    const list = (this.ctx.project()?.labels ?? []).map((l) => ({ ...l, color: labelColor(l) }));
    this.saved.set(list);
    this.labels.set(list);
  }

  colorOf(l: Label) {
    return labelColor(l);
  }

  rename(i: number, name: string) {
    this.labels.update((list) => list.map((l, j) => (j === i ? { ...l, name } : l)));
  }

  recolor(i: number, color: LabelColor) {
    this.labels.update((list) => list.map((l, j) => (j === i ? { ...l, color } : l)));
  }

  remove(i: number) {
    const l = this.labels()[i];
    if (!confirm(this.i18n.t('projectSettings.deleteConfirm', { name: l.name }))) return;
    this.labels.update((list) => list.filter((_, j) => j !== i));
  }

  add() {
    const name = this.newName.trim();
    if (!name) return;
    if (this.isDuplicate(name)) {
      this.error.set('projectSettings.duplicate');
      return;
    }
    // 色は、今あるラベルの数に応じて順番に割り当てる
    const color = LABEL_COLORS[this.labels().length % LABEL_COLORS.length];
    this.labels.update((list) => [...list, { id: crypto.randomUUID().slice(0, 8), name, color }]);
    this.newName = '';
    this.error.set('');
  }

  async save() {
    const list = this.labels().map((l) => ({ ...l, name: l.name.trim() }));
    if (list.some((l) => !l.name)) {
      this.error.set('projectSettings.emptyName');
      return;
    }
    const names = list.map((l) => l.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      this.error.set('projectSettings.duplicate');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ps.updateLabels(this.ctx.pid(), list);
      this.ctx.setLabels(list);
      this.saved.set(list);
      this.labels.set(list);
      this.info.set('settings.saved');
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  discard() {
    this.labels.set(this.saved());
    this.error.set('');
  }

  onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.dirty()) e.preventDefault();
  }

  private isDuplicate(name: string) {
    const n = name.toLowerCase();
    return this.labels().some((l) => l.name.trim().toLowerCase() === n);
  }
}