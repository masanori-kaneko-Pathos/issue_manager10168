import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  DEFAULT_SETTINGS, LABEL_COLORS, Label, LabelColor, MAX_LABELS_PER_PROJECT,
  ProjectSettings as SettingsData, labelColor,
} from '../../core/models';
import { ProjectContext } from './project-context';
import { ProjectService } from '../../core/project/project.service';
import { HelpTip } from '../../shared/help-tip';
import { LabelChip } from '../../shared/label-chip';
import { I18nService, TPipe } from '../../i18n/i18n';

/**
 * 数で決める設定と、その範囲（ルールの validSettings と同じにすること）。
 * notifyHour は画面に出さない（通知の時刻は本人が決める）が、ルールが今も求めるので、値は残して確かめる
 */
type NumKey = 'notifyHour' | 'staleDays' | 'effectCheckDays' | 'highPriorityLimit';
const RANGES: Record<NumKey, [number, number]> = {
  notifyHour: [0, 23], staleDays: [1, 90], effectCheckDays: [1, 90], highPriorityLimit: [1, 100],
};

@Component({
  selector: 'app-tab-settings',
  imports: [FormsModule, TPipe, HelpTip, LabelChip],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    @if (ctx.role() !== 'admin') {
      <p>{{ 'projectSettings.adminOnly' | t }}</p>
    } @else if (ctx.archived()) {
      <p>{{ 'archive.settingsLocked' | t }}</p>
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

      <section>
        <h2>{{ 'projectSettings.rules' | t }}</h2>
        <div class="nums">
          @for (k of dayKeys; track k) {
            <label class="num">
              <span class="name">{{ 'projectSettings.' + k | t }}</span>
              <span class="in">
                <input type="number" inputmode="numeric" step="1" [min]="range(k)[0]" [max]="range(k)[1]"
                  [ngModel]="settings()[k]" (ngModelChange)="setNum(k, $event)" />
                <span>{{ (k === 'highPriorityLimit' ? 'projectSettings.unitCount' : 'projectSettings.unitDays') | t }}</span>
              </span>
              <span class="help">{{ 'projectSettings.' + k + 'Help' | t: { min: '' + range(k)[0], max: '' + range(k)[1] } }}</span>
            </label>
          }
        </div>
      </section>

      <section>
        <h2>{{ 'projectSettings.features' | t }}</h2>
        <label class="feature">
          <input type="checkbox" [checked]="settings().features.gantt"
            (change)="setFeature('gantt', $any($event.target).checked)" />
          <span class="f-body">
            <span class="f-name">{{ 'projectSettings.gantt' | t }}</span>
            <span class="help">{{ 'projectSettings.ganttHelp' | t }}</span>
          </span>
        </label>
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
    .nums { display: flex; flex-direction: column; gap: 14px; max-width: 520px; }
    .num { display: flex; flex-direction: column; gap: 4px; }
    .num .name { font-size: 14px; font-weight: bold; }
    .num select, .num input { min-height: 44px; font-size: 16px; padding: 0 10px; }
    .num select { max-width: 160px; }
    .num .in { display: flex; align-items: center; gap: 6px; }
    .num input { width: 100px; }
    .num .help { margin: 0; }
    .feature { display: flex; align-items: flex-start; gap: 10px; max-width: 520px; cursor: pointer; }
    .feature input { width: 20px; height: 20px; margin-top: 2px; }
    .f-body { display: flex; flex-direction: column; gap: 2px; }
    .f-name { font-size: 14px; font-weight: bold; }
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
  /** 画面で編集中の設定と、保存済みの設定 */
  settings = signal<SettingsData>(DEFAULT_SETTINGS);
  private savedSettings = signal<SettingsData>(DEFAULT_SETTINGS);

  readonly dayKeys: NumKey[] = ['staleDays', 'effectCheckDays', 'highPriorityLimit'];
  newName = '';
  busy = signal(false);
  error = signal('');
  info = signal('');

  private labelsDirty = computed(() => JSON.stringify(this.labels()) !== JSON.stringify(this.saved()));
  private settingsDirty = computed(() => JSON.stringify(this.settings()) !== JSON.stringify(this.savedSettings()));
  /** どちらかに未保存の変更があれば、下に保存のバーを出す（保存は1つのボタンで両方） */
  dirty = computed(() => this.labelsDirty() || this.settingsDirty());

  ngOnInit() {
    // 色が未設定の古いラベルにも、表示どおりの色を入れておく
    const list = (this.ctx.project()?.labels ?? []).map((l) => ({ ...l, color: labelColor(l) }));
    this.saved.set(list);
    this.labels.set(list);
    // 設定は、足りない項目を既定の値で埋めておく（古いプロジェクト用）
    const s = { ...DEFAULT_SETTINGS, ...(this.ctx.project()?.settings ?? {}) };
    this.savedSettings.set(s);
    this.settings.set(s);
  }

  range(k: NumKey) {
    return RANGES[k];
  }

  /** 数を入れる。保存するまでは画面の中だけ */
  setNum(k: NumKey, v: unknown) {
    this.settings.update((s) => ({ ...s, [k]: Number(v) }));
    this.info.set('');
  }

  /** 使う機能のオン・オフ。保存するまでは画面の中だけ（保存は「通知と日数」と同じバー） */
  setFeature(k: keyof SettingsData['features'], v: boolean) {
    this.settings.update((s) => ({ ...s, features: { ...s.features, [k]: v } }));
    this.info.set('');
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
    // 整数で、範囲の中か（関数は notifyHour を === で比べるので、整数でないと二度と届かなくなる）
    const s = this.settings();
    const bad = (Object.keys(RANGES) as NumKey[])
      .some((k) => !Number.isInteger(s[k]) || s[k] < RANGES[k][0] || s[k] > RANGES[k][1]);
    if (bad) {
      this.error.set('projectSettings.rangeError');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      // 変えたほうだけ保存する
      if (this.labelsDirty()) {
        await this.ps.updateLabels(this.ctx.pid(), list);
        this.ctx.setLabels(list);
        this.saved.set(list);
        this.labels.set(list);
      }
      if (this.settingsDirty()) {
        await this.ps.updateSettings(this.ctx.pid(), s);
        this.ctx.setSettings(s);
        this.savedSettings.set(s);
      }
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
    this.settings.set(this.savedSettings());
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