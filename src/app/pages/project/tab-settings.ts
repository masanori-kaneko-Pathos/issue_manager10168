import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import {
  DEFAULT_SETTINGS, LABEL_COLORS, Label, LabelColor, MAX_LABELS_PER_PROJECT,
  ProjectSettings as SettingsData, labelColor,
} from '../../core/models';
import { ProjectContext } from './project-context';
import { ProjectService } from '../../core/project/project.service';
import { SearchService } from '../../core/search/search.service';
import { HelpTip } from '../../shared/help-tip';
import { LabelChip } from '../../shared/label-chip';
import { IndexItem, SideIndex } from '../../shared/side-index';
import { I18nService, TPipe } from '../../i18n/i18n';

/**
 * 数で決める設定と、その範囲（ルールの validSettings と同じにすること）。
 * notifyHour は画面に出さない（通知の時刻は本人が決める）が、ルールが今も求めるので、値は残して確かめる
 */
type NumKey = 'notifyHour' | 'staleDays' | 'effectCheckDays' | 'highPriorityLimit';
const RANGES: Record<NumKey, [number, number]> = {
  notifyHour: [0, 23], staleDays: [1, 90], effectCheckDays: [1, 90], highPriorityLimit: [1, 100],
};
type Section = 'general' | 'labels' | 'rules' | 'features';
type Feature = keyof SettingsData['features'];

/** 左の索引（個人の設定と同じ部品） */
const INDEX: IndexItem[] = [
  { path: 'general', key: 'projectSettings.name', icon: 'M4 20h4L19 9l-4-4L4 16z' },
  { path: 'labels', key: 'projectSettings.labels', icon: 'M3 12V3h9l9 9-9 9zM7.5 7.5h.01' },
  { path: 'rules', key: 'projectSettings.rules', icon: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z' },
  { path: 'features', key: 'projectSettings.features',
    icon: 'M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7zM8 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z' },
];

@Component({
  selector: 'app-tab-settings',
  imports: [FormsModule, TPipe, HelpTip, LabelChip, SideIndex],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    @if (ctx.role() !== 'admin') {
      <p>{{ 'projectSettings.adminOnly' | t }}</p>
    } @else if (ctx.archived()) {
      <p>{{ 'archive.settingsLocked' | t }}</p>
    } @else {
      <div class="layout">
        <app-side-index [items]="index" [prefix]="['..']" label="tabs.settings" />
        <div class="body">
          <h1 class="page-title">{{ titleKey() | t }}</h1>
          @switch (section) {
            @case ('general') {
              <section>
                <input class="pname" [ngModel]="name()" (ngModelChange)="name.set($event); info.set('')" maxlength="100"
                  [attr.aria-label]="'projectSettings.name' | t" />
                <p class="help">{{ 'projectSettings.nameHelp' | t }}</p>
              </section>
            }
            @case ('labels') {
              <section>
                <p class="help">{{ 'projectSettings.labelsHelp' | t }}</p>
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
                    <button type="submit" class="ghost" [disabled]="!newName.trim()">{{ 'projectSettings.add' | t }}</button>
                  </form>
                } @else {
                  <p class="help">{{ 'projectSettings.maxReached' | t: { n: '' + max } }}</p>
                }
              </section>
            }
            @case ('rules') {
              <section>
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
              </section>
            }
            @case ('features') {
              <!-- 使う機能：右端のスイッチ。押したらすぐ保存する（通知設定と同じ手触り） -->
              <section>
                @for (f of featureList; track f) {
                  <label class="sw-row">
                    <span class="f-body">
                      <span class="f-name">{{ 'projectSettings.' + f | t }}</span>
                      <span class="help">{{ 'projectSettings.' + f + 'Help' | t }}</span>
                    </span>
                    <input type="checkbox" role="switch" class="switch" [checked]="savedSettings().features[f]"
                      [disabled]="busy()" (change)="setFeature(f, $event)" />
                  </label>
                }
              </section>
            }
          }
          @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
          @if (info()) { <p class="ok" role="status">{{ info() | t }}</p> }

          @if (dirty()) {
            <div class="savebar" role="status">
              <span>{{ 'settings.unsaved' | t }}</span>
              <button type="button" class="link" [disabled]="busy()" (click)="discard()">{{ 'settings.discard' | t }}</button>
              <button type="button" class="primary" [disabled]="busy()" (click)="save()">{{ 'settings.saveChanges' | t }}</button>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    /* 左に索引、右にページ（個人の設定と同じ形）。スマホは索引を上に横並び */
    .layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; align-items: start; }
    .body { min-width: 0; max-width: 720px; }
    @media (max-width: 720px) {
      .layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    }
    .page-title { font-size: 18px; margin: 0 0 12px; }
    section { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px;
      display: flex; flex-direction: column; gap: 12px; }
    .pname { width: 100%; max-width: 480px; }
    .labels { list-style: none; padding: 0; margin: 0; }
    .labels li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0;
      border-bottom: 1px solid var(--border); }
    .labels input { flex: 1; min-width: 140px; }
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
    .add input { flex: 1; }
    .help { font-size: 12px; color: var(--text-muted); margin: 0; }
    .error { color: var(--danger-text); }
    .ok { color: var(--success-text); }
    .savebar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px; border-radius: 8px; background: var(--warning-bg); border-top: 1px solid var(--warning-border); }
    .savebar span { flex: 1; font-size: 13px; }
    .num { display: flex; flex-direction: column; gap: 4px; }
    .num .name { font-size: 14px; font-weight: bold; }
    .num .in { display: flex; align-items: center; gap: 6px; }
    .num input { width: 100px; }
    /* 左に名前と説明、右端にスイッチ */
    .sw-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; cursor: pointer; }
    .sw-row + .sw-row { padding-top: 12px; border-top: 1px solid var(--border); }
    .f-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .f-name { font-size: 14px; font-weight: bold; }
  `,
})
export class ProjectSettings implements OnInit {
  protected ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private i18n = inject(I18nService);
  private search = inject(SearchService);

  /** このページで出す欄（道の data で決まる。左の索引の1項目にあたる） */
  readonly section = inject(ActivatedRoute).snapshot.data['section'] as Section;
  readonly index = INDEX;
  /** ページの見出し（左の索引と同じ名前） */
  titleKey = computed(() => INDEX.find((x) => x.path === this.section)?.key ?? 'tabs.settings');
  readonly featureList: Feature[] = ['gantt', 'effort', 'recurring'];

  /** 画面で編集中のプロジェクト名と、保存済みの名前 */
  name = signal('');
  private savedName = signal('');
  private nameDirty = computed(() => this.name().trim() !== this.savedName());

  readonly colors = LABEL_COLORS;
  readonly max = MAX_LABELS_PER_PROJECT;

  /** 画面で編集中のラベル */
  labels = signal<Label[]>([]);
  /** 保存済みのラベル（変更があるかの比較用） */
  private saved = signal<Label[]>([]);
  /** 画面で編集中の設定と、保存済みの設定 */
  settings = signal<SettingsData>(DEFAULT_SETTINGS);
  savedSettings = signal<SettingsData>(DEFAULT_SETTINGS);

  readonly dayKeys: NumKey[] = ['staleDays', 'effectCheckDays', 'highPriorityLimit'];
  newName = '';
  busy = signal(false);
  error = signal('');
  info = signal('');

  private labelsDirty = computed(() => JSON.stringify(this.labels()) !== JSON.stringify(this.saved()));
  private settingsDirty = computed(() => JSON.stringify(this.settings()) !== JSON.stringify(this.savedSettings()));
  /** 未保存の変更があれば、下に保存のバーを出す（ページごとに、そのページの欄だけが変わる） */
  dirty = computed(() => this.nameDirty() || this.labelsDirty() || this.settingsDirty());

  ngOnInit() {
    const name = this.ctx.project()?.name ?? '';
    this.savedName.set(name);
    this.name.set(name);
    // 色が未設定の古いラベルにも、表示どおりの色を入れておく
    const list = (this.ctx.project()?.labels ?? []).map((l) => ({ ...l, color: labelColor(l) }));
    this.saved.set(list);
    this.labels.set(list);
    // 設定は、足りない項目を既定の値で埋めておく（古いプロジェクト用）
    const s = { ...DEFAULT_SETTINGS, ...(this.ctx.project()?.settings ?? {}) };
    this.savedSettings.set(s);
    this.settings.set(s);
  }

  /** 今のプロジェクトの設定（見張りで届いた最新。足りない項目は既定の値で埋める） */
  private latest(): SettingsData {
    return { ...DEFAULT_SETTINGS, ...(this.ctx.project()?.settings ?? this.savedSettings()) };
  }

  range(k: NumKey) {
    return RANGES[k];
  }

  /** 数を入れる。保存するまでは画面の中だけ */
  setNum(k: NumKey, v: unknown) {
    this.settings.update((s) => ({ ...s, [k]: Number(v) }));
    this.info.set('');
  }

  /**
   * 使う機能のオン・オフ。押したらすぐ保存する（保存済みの設定に、機能だけを変えて書く）。
   * 失敗したら、スイッチを元に戻して知らせる
   */
  async setFeature(f: Feature, e: Event) {
    const el = e.target as HTMLInputElement;
    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      // その機能の欄だけを書く（ほかの管理者が同時に別の欄を変えても、消さない）
      await this.ps.updateSettingFields(this.ctx.pid(), { [`features.${f}`]: el.checked });
      // 手元の値は、最新（見張りで届いた、ほかの管理者の変更も入ったもの）に、自分が変えた所を重ねる
      const cur = this.latest();
      const next = { ...cur, features: { ...cur.features, [f]: el.checked } };
      this.ctx.setSettings(next);
      this.savedSettings.set(next);
      this.settings.set(next);
      this.info.set('settings.saved');
    } catch (err) {
      console.error(err);
      el.checked = !el.checked;
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
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
    const projectName = this.name().trim();
    if (!projectName) {
      this.error.set('projectSettings.nameEmpty');
      return;
    }
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
      if (this.nameDirty()) {
        await this.ps.rename(this.ctx.pid(), projectName);
        this.savedName.set(projectName);
        this.name.set(projectName);
        // ヘッダーの検索が取っておいたプロジェクト名を捨てる（古い名前で出ないように）
        this.search.invalidate();
      }
      if (this.labelsDirty()) {
        await this.ps.updateLabels(this.ctx.pid(), list);
        this.ctx.setLabels(list);
        this.saved.set(list);
        this.labels.set(list);
      }
      if (this.settingsDirty()) {
        // 開いたときから変えた数の欄だけを書く
        const prev = this.savedSettings();
        const changed: Partial<Record<NumKey, number>> = {};
        for (const k of Object.keys(RANGES) as NumKey[]) if (s[k] !== prev[k]) changed[k] = s[k];
        await this.ps.updateSettingFields(this.ctx.pid(), changed as Record<string, number>);
        // 最新（ほかの管理者の変更も入ったもの）に、自分が変えた欄を重ねて、画面もそれに合わせる
        const merged = { ...this.latest(), ...changed };
        this.ctx.setSettings(merged);
        this.savedSettings.set(merged);
        this.settings.set(merged);
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
    this.name.set(this.savedName());
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