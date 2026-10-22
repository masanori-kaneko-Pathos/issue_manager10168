import { Component, ElementRef, afterEveryRender, computed, inject, signal, viewChild } from '@angular/core';
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

type Step = 'pick' | 'fix' | 'map' | 'review' | 'done';

/** 課題の取り込み。① ファイルを選ぶ → ② 列の対応 → ③ 確認 → ④ 結果 */
@Component({
  selector: 'app-import',
  imports: [RouterLink, TPipe],
  host: { '(document:keydown)': 'onKey($event)', '[animate.leave]': "'im-out-dialog'" },
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
          @for (s of steps(); track s; let i = $index) {
            <li [class.on]="step() === s">{{ i + 1 }}. {{ 'importPage.steps.' + s | t }}</li>
          }
        </ol>

        @if (step() === 'pick') {
          <label class="drop" [class.over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)"
            (drop)="onDrop($event)">
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.pdf" (change)="onPick($event)" />
            <strong>{{ 'importPage.pick' | t }}</strong>
            <span class="help">{{ 'importPage.formats' | t }}</span>
            <span class="help">{{ 'importPage.pdfHint' | t }}</span>
          </label>
          @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        }

        @if (step() === 'fix' && table(); as t) {
          <p class="help">{{ 'importPage.loaded' | t: { name: fileName(), n: '' + (t.length - 1) } }}</p>
          <p class="help">{{ 'importPage.fixHelp' | t }}</p>
          <div class="orphans">
            <button type="button" class="ghost" [disabled]="!history().length" (click)="undoFix()"
              [title]="'importPage.undoKey' | t">{{ 'importPage.undoFix' | t: { n: '' + history().length } }}</button>
            <button type="button" class="ghost" [disabled]="!future().length" (click)="redoFix()"
              [title]="'importPage.redoKey' | t">{{ 'importPage.redoFix' | t: { n: '' + future().length } }}</button>
          </div>
          <p class="help">{{ 'importPage.mergeEmptyHelp' | t }}</p>
          <div class="top-scroll" #topScroll [class.off]="!overflowing()" (scroll)="onTopScroll()" aria-hidden="true">
            <div [style.width.px]="scrollWidth()"></div>
          </div>
          <div class="table-wrap" #wrap (scroll)="onWrapScroll()">
            <table class="fix">
              <thead>
                <tr class="col-ops">
                  <td class="ops"></td>
                  @for (n of emptyCounts(); track $index; let ci = $index) {
                    <td>
                      @if (n) {
                        <button type="button" class="col-merge" (click)="mergeEmpty(ci)"
                          [attr.aria-label]="'importPage.mergeEmptyCol' | t: { col: table()![0][ci] || '' + (ci + 1), n: '' + n }">
                          {{ 'importPage.mergeEmpty' | t: { n: '' + n } }}</button>
                      }
                    </td>
                  }
                </tr>
              </thead>
              <tbody>
                @for (r of t; track $index; let ri = $index) {
                  <tr [class.head-row]="ri === 0">
                    <td class="ops">
                      @if (ri > 1) {
                        <button type="button" class="mini" [title]="'importPage.mergeUp' | t"
                          [attr.aria-label]="'importPage.mergeUp' | t" (click)="mergeUp(ri)">↑</button>
                      }
                      @if (ri > 0) {
                        <button type="button" class="mini" [title]="'importPage.removeRow' | t"
                          [attr.aria-label]="'importPage.removeRow' | t" (click)="removeRow(ri)">✕</button>
                      }
                    </td>
                    @for (v of r; track $index; let ci = $index) {
                      <td><textarea [value]="v" [rows]="linesOf(v)" (change)="setCell(ri, ci, $any($event.target).value)"
                        [attr.aria-label]="'importPage.cell' | t: { r: '' + (ri + 1), c: '' + (ci + 1) }"></textarea></td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="row">
            <button type="button" class="link" (click)="reset()">{{ 'importPage.again' | t }}</button>
            <button type="button" class="primary" [disabled]="t.length < 2" (click)="toMap()">
              {{ 'importPage.toMap' | t }}</button>
          </div>
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
            @if (isPdf()) {
              <button type="button" class="link" (click)="step.set('fix')">{{ 'importPage.backToFix' | t }}</button>
            } @else {
              <button type="button" class="link" (click)="reset()">{{ 'importPage.again' | t }}</button>
            }
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

          <div class="top-scroll" #topScroll [class.off]="!overflowing()" (scroll)="onTopScroll()" aria-hidden="true">
            <div [style.width.px]="scrollWidth()"></div>
          </div>
          <div class="table-wrap" #wrap (scroll)="onWrapScroll()">
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
    .fix td { padding: 2px; }
    .fix textarea { display: block; width: 100%; min-width: 120px; box-sizing: border-box; min-height: 32px;
      font: inherit; font-size: 13px; line-height: 1.5; padding: 5px 6px; border: 1px solid transparent;
      background: none; resize: none; overflow: hidden; }
    .fix textarea:focus { border-color: var(--primary); background: var(--surface); }
    .fix tr.head-row textarea { font-weight: bold; }
    .fix tr.head-row td { background: var(--surface-alt); }
    /* ↑・✕ の列は、右へスクロールしても左に残す（行をまとめながら、右の列の中身を確かめられるように） */
    .fix .ops { white-space: nowrap; width: 1%; position: sticky; left: 0; z-index: 1;
      background: var(--surface); box-shadow: 1px 0 0 var(--border); }
    .fix tr.head-row .ops { background: var(--surface-alt); }
    .mini { min-width: 28px; min-height: 28px; border: none; background: none; color: var(--text-muted);
      border-radius: 6px; cursor: pointer; }
    .mini:hover { background: var(--surface-muted); color: var(--text); }
    .orphans { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 8px 0; }
    .ghost { min-height: 40px; padding: 0 16px; border: 1px solid var(--primary); border-radius: 8px;
      background: var(--surface); color: var(--primary); font-size: 14px; cursor: pointer; }
    .ghost:hover { background: var(--primary-bg); }
    .ghost:disabled { border-color: var(--border-strong); color: var(--text-disabled); cursor: default; background: none; }
    .fix tr.col-ops td { padding: 2px; border: none; background: none; }
    .fix tr.col-ops .ops { background: var(--surface); box-shadow: none; }
    .col-merge { width: 100%; min-height: 28px; padding: 0 6px; border: 1px dashed var(--border-strong);
      border-radius: 6px; background: none; color: var(--text-muted); font-size: 11px; white-space: nowrap;
      cursor: pointer; }
    .col-merge:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-bg); }
    .top-scroll { overflow-x: auto; overflow-y: hidden; height: 14px; margin-top: 8px; }
    .top-scroll > div { height: 1px; }
    .top-scroll.off { visibility: hidden; height: 0; margin: 0; }
    .top-scroll + .table-wrap { margin-top: 2px; }
    `,
})
export class ImportPage {
  protected ctx = inject(ProjectContext);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  /** 段の並び。PDF のときだけ「読み取りの確認」が入る */
  steps = computed<Step[]>(() => this.isPdf()
    ? ['pick', 'fix', 'map', 'review', 'done'] : ['pick', 'map', 'review', 'done']);
  /** 今の表が PDF から読んだものか */
  isPdf = computed(() => !!this.sheets()[this.sheetIndex()]?.pdf);
  readonly fields = FIELDS;
  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly dueOptions = [3, 7, 14, 30];
  readonly maxRows = MAX_ROWS;
  // ---- 上の横スクロールのバー（かんばんと同じ仕組み） ----
  private wrap = viewChild<ElementRef<HTMLElement>>('wrap');
  private topScroll = viewChild<ElementRef<HTMLElement>>('topScroll');
  /** 表の横の長さ（上のバーの中身を、同じ長さにするため） */
  scrollWidth = signal(0);
  /** 表が画面からはみ出しているか（はみ出していなければ、上のバーは出さない） */
  overflowing = signal(false);
  /** 片方を動かしたとき、もう片方の「動いた」の知らせで動かし返さないための目印 */
  private syncing = false;

  constructor() {
    // 描き直すたびに、表の横の長さを測り直す（行をまとめた・段を移ったときにも追いつくため）。
    // 値が変わったときだけ入れるので、描き直しが続けて起きることはない
    afterEveryRender(() => {
      const el = this.wrap()?.nativeElement;
      if (!el) return;
      const w = el.scrollWidth;
      const over = w > el.clientWidth + 1;
      if (w !== this.scrollWidth()) this.scrollWidth.set(w);
      if (over !== this.overflowing()) this.overflowing.set(over);
    });
  }

  /** 表を動かしたら、上のバーもついてくる */
  onWrapScroll() {
    this.follow(this.wrap()?.nativeElement, this.topScroll()?.nativeElement);
  }

  /** 上のバーを動かしたら、表もついてくる */
  onTopScroll() {
    this.follow(this.topScroll()?.nativeElement, this.wrap()?.nativeElement);
  }

  /** from の位置に to を合わせる。位置がもうそろっていれば何もしない（行ったり来たりを止める） */
  private follow(from?: HTMLElement, to?: HTMLElement) {
    if (!from || !to || this.syncing || Math.abs(from.scrollLeft - to.scrollLeft) < 1) return;
    this.syncing = true;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => (this.syncing = false));
  }

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
      this.step.set(this.isPdf() ? 'fix' : 'map');
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
    this.history.set([]);
    this.future.set([]);
  }

  // ---- 読み取りの確認（PDF だけ） ----

  /** 読み取りの確認で、直す前の表を積んでおく（新しいものが後ろ。50回分まで） */
  history = signal<string[][][]>([]);

  /** 戻したあとの表を積んでおく（「進める」で取り出す） */
  future = signal<string[][][]>([]);

  /**
   * 直す前の表を積む。表は直すたびに新しく作るので、今の表をそのまま積めばよい。
   * 新しく直したら、「進める」の山は捨てる（戻したあとに別の直しをしたら、進める先は無くなるため）
   */
  private snapshot() {
    const t = this.table();
    if (t) this.history.update((h) => [...h.slice(-49), t]);
    this.future.set([]);
  }

  /** 1つ前の表に戻す（今の表は「進める」の山へ） */
  undoFix() {
    const h = this.history();
    const now = this.table();
    if (!h.length || !now) return;
    this.future.update((f) => [...f, now]);
    this.table.set(h[h.length - 1]);
    this.history.set(h.slice(0, -1));
  }

  /** 戻した直しを、もう一度やる（今の表は「戻す」の山へ） */
  redoFix() {
    const f = this.future();
    const now = this.table();
    if (!f.length || !now) return;
    this.history.update((h) => [...h, now]);
    this.table.set(f[f.length - 1]);
    this.future.set(f.slice(0, -1));
  }

  /** 読み取りの確認の間だけ、Ctrl＋Z で戻す、Ctrl＋Y（Ctrl＋Shift＋Z）で進める。マスの中で打っている間は効かせない */
  onKey(e: KeyboardEvent) {
    if (this.step() !== 'fix' || !(e.ctrlKey || e.metaKey)) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undoFix();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      this.redoFix();
    }
  }
  /** マスを直す。打ち終わったとき（欄を離れたとき）に1回だけ（打つたびに表を作り直さないため） */
  setCell(r: number, c: number, v: string) {
    this.snapshot();
    this.table.update((t) => t!.map((row, i) => (i !== r ? row : row.map((x, j) => (j === c ? v : x)))));
  }

  /** マスの欄の行数：中身の改行の数に合わせる（ふつうのマスは1行のまま） */
  linesOf(v: string) {
    return Math.max(1, v.split('\n').length);
  }

  /** 列ごとの、空の行の数（1つ目の課題の行は、まとめる先がないので数えない） */
  emptyCounts = computed(() => {
    const t = this.table();
    if (!t) return [];
    return t[0].map((_, c) => t.slice(2).filter((r) => !r[c]?.trim()).length);
  });

  /**
   * その列が空の行を、全部すぐ上の行とまとめる（改行で別の行に分かれたとき）。
   * どの列を手がかりにするかは人が選ぶ（番号・タイトル・提起者のように、必ず埋まっている列で押す）
   */
  mergeEmpty(c: number) {
    this.snapshot();
    this.table.update((t) => {
      const out: string[][] = [];
      t!.forEach((row, i) => {
        const last = out[out.length - 1];
        // 2つ目以降の課題の行で、その列が空なら、上の行（すでにまとめた行も含む）に足す
        if (i >= 2 && !row[c]?.trim()) out[out.length - 1] = last.map((v, j) => joinLines(v, row[j]));
        else out.push([...row]);
      });
      return out;
    });
  }

  /** 上の行とまとめる（折り返した文が、別の行に分かれてしまったとき） */
  mergeUp(r: number) {
    this.snapshot();
    this.table.update((t) => {
      const next = t!.map((row) => [...row]);
      next[r - 1] = next[r - 1].map((v, j) => joinLines(v, next[r][j]));
      next.splice(r, 1);
      return next;
    });
  }

  /** 行を消す（題やページの飾りなど、課題でない行が入ったとき） */
  removeRow(r: number) {
    this.snapshot();
    this.table.update((t) => t!.filter((_, i) => i !== r));
  }

  /** 直した見出しで、列の対応を当て直してから進む */
  toMap() {
    this.mapping.set(guessColumns(this.table()![0]));
    this.overrides.set(new Map());
    this.step.set('map');
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

/**
 * 行をまとめるときのつなぎ方：改行でつなぐ。
 * PDF で別の行に分かれたのは、元のマスの中で改行していたからなので、改行で戻すのが元の形に一番近い
 */
function joinLines(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\n${b}`;
}