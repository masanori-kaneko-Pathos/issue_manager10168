import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ImportError, SheetTable, readTables } from '../../core/import/parse';
import {
  DEFAULTS, Draft, FIELDS, Field, ISSUE_TYPES, MAX_ROWS, convertRows, guessColumns,
} from '../../core/import/convert';
import { IssueService } from '../../core/issue/issue.service';
import { AuthService } from '../../core/auth/auth.service';
import { auth } from '../../core/firebase';
import { Clock } from '../../core/time/clock';
import { shortDue } from '../../core/time/time';
import { IssueType, Level } from '../../core/models';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';

type Step = 'pick' | 'map' | 'review' | 'done';

/** 課題の取り込み。① ファイルを選ぶ → ② 列の対応 → ③ 確認 → ④ 結果 */
@Component({
  selector: 'app-import',
  imports: [RouterLink, TPipe],
  template: `
    <section>
      <div class="head">
        <h2>{{ 'importPage.title' | t }}</h2>
        <a class="link" [routerLink]="['/p', ctx.pid(), 'list']">{{ 'trash.back' | t }}</a>
      </div>

      @if (ctx.role() === 'viewer') {
        <p>{{ 'importPage.viewerCannot' | t }}</p>
      } @else if (ctx.archived()) {
        <p>{{ 'archive.readonly' | t }}</p>
      } @else {
        <ol class="steps">
          @for (s of steps; track s; let i = $index) {
            <li [class.on]="step() === s">{{ i + 1 }}. {{ 'importPage.steps.' + s | t }}</li>
          }
        </ol>

        @if (step() === 'pick') {
          <label class="drop" [class.over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)"
            (drop)="onDrop($event)">
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" (change)="onPick($event)" />
            <strong>{{ 'importPage.pick' | t }}</strong>
            <span class="help">{{ 'importPage.formats' | t }}</span>
          </label>
          @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        }

        @if (step() === 'map' && table(); as t) {
          <p class="help">{{ 'importPage.loaded' | t: { name: fileName(), n: '' + (t.length - 1) } }}</p>
          @if (sheets().length > 1) {
            <label class="sheet">{{ 'importPage.sheet' | t }}
              <select (change)="useSheet(+$any($event.target).value)">
                @for (s of sheets(); track $index; let i = $index) {
                  <option [value]="i" [selected]="sheetIndex() === i">{{ s.name }}（{{ s.rows.length - 1 }}）</option>
                }
              </select>
            </label>
          }
          @if (t.length - 1 > maxRows) {
            <p class="warn" role="alert">{{ 'importPage.tooMany' | t: { n: '' + maxRows } }}</p>
          }
          <p class="help">{{ 'importPage.mapHelp' | t }}</p>
          <div class="table-wrap">
            <table class="map">
              <thead><tr>
                <th>{{ 'importPage.colFile' | t }}</th><th>{{ 'importPage.colSample' | t }}</th>
                <th>{{ 'importPage.colField' | t }}</th>
              </tr></thead>
              <tbody>
                @for (h of t[0]; track $index; let i = $index) {
                  <tr [class.off]="!mapping()[i]">
                    <td>{{ h }}</td>
                    <td class="sample">{{ t[1][i] }}</td>
                    <td>
                      <select [attr.aria-label]="h" (change)="setField(i, $any($event.target).value)">
                        <option value="" [selected]="!mapping()[i]">{{ 'importPage.skipColumn' | t }}</option>
                        @for (f of fields; track f) {
                          <option [value]="f" [selected]="mapping()[i] === f">{{ 'csv.cols.' + f | t }}</option>
                        }
                      </select>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (!hasTitle()) { <p class="error" role="alert">{{ 'importPage.needTitle' | t }}</p> }
          <div class="row">
            <button type="button" class="link" (click)="reset()">{{ 'importPage.again' | t }}</button>
            <button type="button" class="primary" [disabled]="!hasTitle() || !existing()" (click)="toReview()">
              {{ 'importPage.toReview' | t }}</button>
          </div>
        }

        @if (step() === 'review') {
          <div class="defaults">
            <span class="help">{{ 'importPage.defaults' | t }}</span>
            <label>{{ 'csv.cols.type' | t }}
              <select (change)="setDefault('type', $any($event.target).value)">
                @for (x of types; track x) {
                  <option [value]="x" [selected]="defaults().type === x">{{ 'issueTypes.' + x | t }}</option>
                }
              </select></label>
            <label>{{ 'csv.cols.importance' | t }}
              <select (change)="setDefault('importance', $any($event.target).value)">
                @for (x of levels; track x) {
                  <option [value]="x" [selected]="defaults().importance === x">{{ 'importance.' + x | t }}</option>
                }
              </select></label>
            <label>{{ 'csv.cols.due' | t }}
              <select (change)="setDefault('dueDays', +$any($event.target).value)">
                @for (x of dueOptions; track x) {
                  <option [value]="x" [selected]="defaults().dueDays === x">{{ 'importPage.dueAfter' | t: { n: '' + x } }}</option>
                }
              </select></label>
          </div>

          <p class="summary">{{ 'importPage.summary' | t: { ok: '' + counts().ok, off: '' + counts().off, bad: '' + counts().bad } }}</p>

          <div class="table-wrap">
            <table class="review">
              <thead><tr>
                <th></th><th>{{ 'importPage.colLine' | t }}</th><th>{{ 'csv.cols.title' | t }}</th>
                <th>{{ 'csv.cols.type' | t }}</th><th>{{ 'csv.cols.importance' | t }}</th><th>{{ 'csv.cols.due' | t }}</th>
                <th>{{ 'csv.cols.assignee' | t }}</th><th>{{ 'csv.cols.status' | t }}</th><th>{{ 'importPage.colNotes' | t }}</th>
              </tr></thead>
              <tbody>
                @for (d of drafts(); track d.line) {
                  @let bad = isBad(d);
                  @let on = included(d);
                  <tr [class.off]="!on">
                    <td><input type="checkbox" [checked]="on" [disabled]="bad"
                      [attr.aria-label]="'importPage.includeRow' | t: { n: '' + d.line }" (change)="toggle(d)" /></td>
                    <td>{{ d.line }}</td>
                    <td class="title">{{ d.values.title || '—' }}</td>
                    <td>{{ 'issueTypes.' + d.values.type | t }}</td>
                    <td>{{ 'importance.' + d.values.importance | t }}</td>
                    <td>{{ due(d) }}</td>
                    <td>{{ ctx.nameOf(d.values.assigneeId) }}</td>
                    <td>{{ 'status.' + d.values.status | t }}</td>
                    <td class="notes">
                      @for (n of d.notes; track $index) {
                        <span class="note" [attr.data-l]="n.level">{{ n.key | t: n.params }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (running(); as r) {
            <p class="summary" role="status">{{ 'importPage.running' | t: { done: '' + r.done, total: '' + r.total } }}</p>
          }
          <div class="row">
            <button type="button" class="link" [disabled]="!!running()" (click)="step.set('map')">
              {{ 'importPage.backToMap' | t }}</button>
            <button type="button" class="primary" [disabled]="!counts().ok || !!running()" (click)="run()">
              {{ 'importPage.run' | t: { n: '' + counts().ok } }}</button>
          </div>
        }

        @if (step() === 'done' && result(); as res) {
          <p class="summary" role="status">{{ (res.undone ? 'importPage.undone' : 'importPage.done') | t: { n: '' + res.count } }}</p>
          @if (res.failed.length) {
            <p class="error" role="alert">{{ 'importPage.failed' | t: { n: '' + res.failed.length, lines: res.failed.join(', ') } }}</p>
          }
          @if (!res.undone && res.count) {
            <p class="help">{{ 'importPage.undoNote' | t }}</p>
          }
          <div class="row">
            @if (!res.undone && res.count) {
              <button type="button" class="link danger" [disabled]="undoing()" (click)="undo()">
                {{ 'importPage.undo' | t }}</button>
            }
            <a class="primary" [routerLink]="['/p', ctx.pid(), 'list']">{{ 'importPage.toList' | t }}</a>
          </div>
        }
      }
    </section>
  `,
  styles: `
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 16px; }
    .link { color: var(--primary); text-decoration: none; font-size: 14px; background: none; border: none;
      min-height: 40px; cursor: pointer; }
    .steps { display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; padding: 0; margin: 0 0 12px;
      font-size: 13px; color: var(--text-muted); }
    .steps li.on { color: var(--primary); font-weight: bold; }
    .drop { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 28px 16px; border: 2px dashed var(--border-strong); border-radius: 12px; text-align: center; cursor: pointer; }
    .drop.over { border-color: var(--primary); background: var(--primary-bg); }
    .drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .help { font-size: 12px; color: var(--text-muted); margin: 6px 0; }
    .error { color: var(--danger-text); font-size: 13px; }
    .warn { padding: 8px 12px; border-radius: 8px; font-size: 13px; background: var(--warning-bg); color: var(--warning-text); }
    .table-wrap { overflow-x: auto; margin-top: 8px; }
    table { border-collapse: collapse; font-size: 12px; }
    th, td { padding: 6px 8px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: var(--surface-alt); white-space: nowrap; }
    tr.off td { color: var(--text-subtle); }
    .map .sample { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    select { min-height: 36px; font-size: 13px; }
    .review .title { min-width: 180px; overflow-wrap: anywhere; }
    .review td { white-space: nowrap; }
    .review td.title, .review td.notes { white-space: normal; }
    .notes { min-width: 220px; }
    .note { display: block; margin: 0 0 2px; padding: 1px 6px; border-radius: 6px; }
    .note[data-l='error'] { background: var(--danger-bg); color: var(--danger-text); }
    .note[data-l='skip'] { background: var(--surface-muted); color: var(--text-secondary); }
    .note[data-l='warn'] { background: var(--warning-bg); color: var(--warning-text); }
    .defaults { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 12px;
      border-radius: 8px; background: var(--surface-alt); }
    .defaults label { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .summary { font-size: 14px; font-weight: bold; margin: 12px 0 4px; }
    .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
    .danger { color: var(--danger-text); }
    a.primary { display: inline-flex; align-items: center; text-decoration: none; }
    .sheet { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 4px 0 8px; }
  `,
})
export class ImportPage {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  readonly steps: Step[] = ['pick', 'map', 'review', 'done'];
  readonly fields = FIELDS;
  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly dueOptions = [3, 7, 14, 30];
  readonly maxRows = MAX_ROWS;

  step = signal<Step>('pick');
  table = signal<string[][] | null>(null);
  /** 読んだ表（Excel はシートごと）と、使っているシート */
  sheets = signal<SheetTable[]>([]);
  sheetIndex = signal(0);
  fileName = signal('');
  error = signal('');
  over = signal(false);
  /** 列ごとの項目（null＝取り込まない） */
  mapping = signal<(Field | null)[]>([]);
  defaults = signal({ ...DEFAULTS });
  /** プロジェクトの今の課題のタイトル（重複の見つけ方に使う。ファイルを読んだときに1回読む） */
  existing = signal<string[] | null>(null);
  /** 確認画面で、人がチェックを変えた行（行番号 → 取り込むか）。列の対応を変えたら消す */
  private overrides = signal(new Map<number, boolean>());
  /** 取り込みの最中（何件中、何件まで済んだか） */
  running = signal<{ done: number; total: number } | null>(null);
  /** 結果（取り込んだ件数・取り込めなかった行・取り消したか） */
  result = signal<{ importId: string; count: number; failed: number[]; undone: boolean } | null>(null);
  undoing = signal(false);

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  hasTitle = computed(() => this.mapping().includes('title'));

  /** 下書き：表・列の対応・空のときの値が変わるたびに作り直す（書き込みはしない） */
  drafts = computed<Draft[]>(() => {
    const t = this.table();
    if (!t || !this.existing()) return [];
    return convertRows(t, this.mapping(), {
      role: this.ctx.role() ?? 'member',
      myUid: auth.currentUser!.uid,
      members: this.ctx.members(),
      labels: this.ctx.project()?.labels ?? [],
      existingTitles: this.existing()!,
      tz: this.tz(),
      nowMs: this.clock.now(),
      defaults: this.defaults(),
      t: (k, p) => this.i18n.t(k, p),
    });
  });
  counts = computed(() => {
    const list = this.drafts();
    const bad = list.filter((d) => this.isBad(d)).length;
    const ok = list.filter((d) => this.included(d)).length;
    return { ok, bad, off: list.length - ok - bad };
  });

  // ---- ① ファイルを選ぶ ----
  onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 同じファイルを選び直しても、もう一度読めるように
    if (file) this.load(file);
  }
  onDragOver(e: DragEvent) {
    e.preventDefault(); // これがないと、ブラウザがファイルを開いてしまう
    this.over.set(true);
  }
  onDrop(e: DragEvent) {
    e.preventDefault();
    this.over.set(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) this.load(file);
  }

  private async load(file: File) {
    this.error.set('');
    try {
      this.sheets.set(await readTables(file));
      this.fileName.set(file.name);
      this.useSheet(0);
      this.step.set('map');
      // 重複を見るために、今の課題のタイトルを1回だけ読む（削除フォルダは除く）
      const all = await this.issueService.listAll(this.ctx.pid());
      this.existing.set(all.filter((i) => i.status !== 'deleted').map((i) => i.title));
    } catch (e) {
      console.error(e);
      this.error.set(e instanceof ImportError ? 'importPage.errors.' + e.code : 'importPage.errors.read');
      this.step.set('pick');
    }
  }

  reset() {
    this.table.set(null);
    this.existing.set(null);
    this.step.set('pick');
  }

  /** シートを選ぶ（列の対応は、そのシートの見出しから当て直す） */
  useSheet(i: number) {
    const t = this.sheets()[i].rows;
    this.sheetIndex.set(i);
    this.table.set(t);
    this.mapping.set(guessColumns(t[0]));
    this.overrides.set(new Map());
  }
  // ---- ② 列の対応 ----
  /** 選び直した項目が、ほかの列で使われていたら、そちらは外す（1つの項目に2つの列を当てない） */
  setField(i: number, v: string) {
    const f = (v || null) as Field | null;
    this.mapping.update((m) => m.map((x, j) => (j === i ? f : f && x === f ? null : x)));
    this.overrides.set(new Map());
  }

  toReview() {
    this.step.set('review');
  }

  // ---- ③ 確認 ----
  setDefault(k: 'type' | 'importance' | 'dueDays', v: IssueType | Level | number) {
    this.defaults.update((d) => ({ ...d, [k]: v }));
  }

  isBad(d: Draft) {
    return d.notes.some((n) => n.level === 'error');
  }
  /** 取り込むか：人が変えていればそれ、なければ下書きの初期値 */
  included(d: Draft) {
    return !this.isBad(d) && (this.overrides().get(d.line) ?? d.include);
  }
  toggle(d: Draft) {
    const next = !this.included(d);
    this.overrides.update((m) => new Map(m).set(d.line, next));
  }

  due(d: Draft) {
    return shortDue(d.values.dueAt, this.tz(), this.i18n.lang(), this.clock.now());
  }

  
  // ---- ④ 取り込む ----
  /** 1件ずつ登録する。1件の失敗で止めず、取り込めなかった行は最後に知らせる */
  async run() {
    const list = this.drafts().filter((d) => this.included(d));
    if (!list.length) return;
    const importId = crypto.randomUUID();
    const uid = auth.currentUser!.uid;
    const failed: number[] = [];
    this.running.set({ done: 0, total: list.length });
    for (const [i, d] of list.entries()) {
      try {
        await this.issueService.importIssue(this.ctx.pid(), d.values, importId, uid, this.tz());
      } catch (e) {
        console.error(e);
        failed.push(d.line);
      }
      this.running.set({ done: i + 1, total: list.length });
    }
    const count = list.length - failed.length;
    if (count) {
      await this.issueService.logImport(this.ctx.pid(), count, uid, this.ctx.role() ?? 'member')
        .catch((e) => console.warn('管理ログに書けませんでした', e));
    }
    this.running.set(null);
    this.result.set({ importId, count, failed, undone: false });
    this.step.set('done');
  }

  /** この回の取り込みを、まとめて削除フォルダへ（取り込んだ本人は24時間以内、管理者はいつでも） */
  async undo() {
    const res = this.result();
    if (!res || !confirm(this.i18n.t('importPage.undoConfirm', { n: String(res.count) }))) return;
    this.undoing.set(true);
    try {
      const n = await this.issueService.undoImport(
        this.ctx.pid(), res.importId, this.i18n.t('importPage.undoReason'), auth.currentUser!.uid, this.tz());
      this.result.set({ ...res, count: n, undone: true });
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.undoing.set(false);
    }
  }
}