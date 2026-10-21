import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { bigrams, coverage } from '../../core/search/match';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { IssueService } from '../../core/issue/issue.service';
import { InboxService } from '../../core/inbox/inbox.service';
import { ISSUE_TYPES, IssueLink, IssueType, Level, Member, ProjectWithRole, Issue, toHours } from '../../core/models';
import { dateKey, endOfDayIn, formatDateTime, parseLocalInput, toLocalInput, zonedTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { HelpTip } from '../../shared/help-tip';
import { LabelPicker } from '../../shared/label-picker';
import { MemberSelect } from '../../shared/member-select';
import { DraftService } from '../../core/draft/draft.service';
import { AttachmentService, checkFile } from '../../core/attachment/attachment.service';
import { MAX_ATTACHMENTS } from '../../core/models';
import { sizeText } from './attachment-list';
import { ImageViewer, ViewerImage } from '../../shared/image-viewer';

const LAST_PROJECT_KEY = 'issuemanager.lastProject';

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeLastProject(pid: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, pid);
  } catch {
    // 保存できなくても登録には影響しない
  }
}

/** 登録画面の下書きにしまう中身 */
interface IssueDraft {
  pid: string | null;
  title: string;
  type: IssueType | null;
  importance: Level | null;
  dueMs: number | null;
  assigneeId: string;
  doneCriteria: string;
  description: string;
  labelIds: string[];
  occurredOn: string;
  impact: string;
  showDetail: boolean;
  estimate?: number | null;
}

@Component({
  selector: 'app-issue-new',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelPicker, MemberSelect, ImageViewer],
  template: `
    <header class="bar"><a [routerLink]="backLink()" class="link">{{ 'common.back' | t }}</a></header>
    <main>
      <h1>{{ 'issueNew.title' | t }}</h1>
      @if (fromNumber(); as n) { <p class="notice">{{ 'prevention.creating' | t: { n: '' + n } }}</p> }
      @if (copyNumber(); as n) { <p class="notice">{{ 'copy.creating' | t: { n: '' + n } }}</p> }
      @if (recurNumber(); as n) { <p class="notice">{{ 'links.recurCreating' | t: { n: '' + n } }}</p> }
      @if (splitNote(); as s) { <p class="notice">{{ 'subtask.splitCreating' | t: { n: '' + s.n, title: s.title } }}</p> }      
      <!-- 入力・選択・ボタンの操作は、どれも form まで上がってくるので、ここで1回だけ受けて下書きにしまう -->
      <form (ngSubmit)="save()" (input)="touch()" (change)="touch()" (click)="touch()">
              @if (!loadingProjects() && projects().length === 0) {
          <p class="notice">
            {{ 'issueNew.noProject' | t }}
            <a routerLink="/">{{ 'issueNew.toProjects' | t }}</a>
          </p>
        }
        @if (projects().length) {
          <div class="field">
            <span><label for="f-project">{{ 'issueNew.project' | t }}</label></span>
            <select id="f-project" name="project" [ngModel]="pid()" (ngModelChange)="selectProject($event)">
              @for (p of projects(); track p.id) {
                <option [value]="p.id">{{ p.name }}</option>
              }
            </select>
          </div>
        }
        <div class="field">
          <span><label for="f-title">{{ 'issue.title' | t }}</label> <app-help-tip [keys]="['help.title']" /></span>
          <input id="f-title" name="title" [(ngModel)]="title" (ngModelChange)="onTitle($event)" maxlength="200"
            required autofocus [placeholder]="'issueNew.titlePlaceholder' | t" />
          @if (similar().length) {
            <div class="similar" role="status">
              <p>{{ 'issueNew.similar' | t }}</p>
              <ul>
                @for (s of similar(); track s.id) {
                  <li>
                    <a [routerLink]="['/p', pid(), 'i', s.id]" target="_blank" rel="noopener">#{{ s.number }} {{ s.title }}</a>
                    <span class="st">{{ 'status.' + s.status | t }}</span>
                  </li>
                }
              </ul>
              <p class="similar-help">{{ 'issueNew.similarHelp' | t }}</p>
            </div>
          }
        </div>

        <fieldset>
          <legend>{{ 'issue.type' | t }} <app-help-tip [keys]="['help.type']" /></legend>
          <div class="chips">
            @for (t of types; track t) {
              <button type="button" [class.on]="type() === t" [attr.aria-pressed]="type() === t"
                (click)="selectType(t)">{{ 'issueTypes.' + t | t }}</button>
            }
          </div>
        </fieldset>

        <fieldset>
          <legend>{{ 'issue.importance' | t }} <app-help-tip [keys]="['help.importance']" /></legend>
          <div class="chips">
            @for (l of levels; track l) {
              <button type="button" [class.on]="importance() === l" [attr.aria-pressed]="importance() === l"
                (click)="importance.set(l)">{{ 'importance.' + l | t }}</button>
            }
          </div>
        </fieldset>

        <fieldset>
          <legend>{{ 'issue.due' | t }} <app-help-tip [keys]="['help.due']" /></legend>
          <div class="chips">
            @for (p of duePresets; track p.key) {
              <button type="button" [class.on]="duePreset() === p.key" [attr.aria-pressed]="duePreset() === p.key"
                (click)="pickPreset(p.key, p.days)">{{ 'duePresets.' + p.key | t }}</button>
            }
          </div>
          <input type="datetime-local" name="due" [ngModel]="dueInput" (ngModelChange)="onDueInput($event)" />
          @if (dueAt()) { <p class="help">{{ dueLabel() }}（{{ tz() }}）</p> }
          @if (isPastDue()) {
            <p class="warn" role="alert">{{ 'dueDialog.pastWarning' | t }}</p>
          }
        </fieldset>

        <div class="field">
          <span><label for="f-assignee">{{ 'issue.assignee' | t }}</label></span>
          <app-member-select selectId="f-assignee" [members]="members()" [value]="assigneeId()"
            (picked)="assigneeId.set($event)" />
        </div>

        <div class="field">
          <span><label for="f-done">{{ 'issue.doneCriteria' | t }}</label> <app-help-tip [keys]="['help.doneCriteria']" /></span>
          <textarea id="f-done" name="doneCriteria" [(ngModel)]="doneCriteria" rows="2" required></textarea>
        </div>

        <button type="button" class="link" (click)="showDetail.set(!showDetail())">
          {{ (showDetail() ? 'issueNew.hideDetail' : 'issueNew.showDetail') | t }}
        </button>
        @if (showDetail()) {
          <div class="field">
            <span>{{ 'issue.labelIds' | t }}</span>
            <app-label-picker [labels]="currentLabels()" [(selected)]="labelIds" />
          </div>
          <label class="field">{{ 'issue.description' | t }}
            <textarea name="description" [(ngModel)]="description" rows="6"></textarea>
          </label>
          <div class="field">
            <span><label for="f-occurred">{{ 'issue.occurredOn' | t }}</label> <app-help-tip [keys]="['help.occurredOn']" /></span>
            <input id="f-occurred" type="date" name="occurredOn" [(ngModel)]="occurredOn" [max]="today()" />
          </div>
          <div class="field">
            <span><label for="f-impact">{{ 'issue.impact' | t }}</label> <app-help-tip [keys]="['help.impact']" /></span>
            <input id="f-impact" name="impact" [(ngModel)]="impact" maxlength="200"
              [placeholder]="'issueNew.impactPlaceholder' | t" />
          </div>
          @if (effortOn()) {
            <div class="field">
              <span><label for="f-estimate">{{ 'issue.estimateHours' | t }}</label></span>
              <span class="hours">
                <input id="f-estimate" type="number" name="estimate" min="0" max="999" step="0.5" [(ngModel)]="estimate" />
                {{ 'effort.unit' | t }}</span>
              <p class="help">{{ 'effort.hint' | t }}</p>
            </div>
          }
          <div class="field">
            <span>{{ 'attach.title' | t }}</span>
            <div class="drop" [class.over]="over()" (dragover)="onDragOver($event)" (dragleave)="over.set(false)"
              (drop)="onDrop($event)">
              @if (pending().length) {
                <ul class="pending">
                  @for (f of pending(); track $index; let k = $index) {
                    <li>
                      @if (f.url) {
                        <button type="button" class="pthumb" [attr.aria-label]="'attach.view' | t: { name: f.file.name }"
                          (click)="viewPending(k)">
                          <img [src]="f.url" alt="" (error)="$any($event.target).style.visibility = 'hidden'" />
                        </button>
                      }
                      <span class="pname">{{ f.file.name }}</span>
                      <span class="psize">{{ size(f.file.size) }}</span>
                      @if (progress(); as pr) {
                        <span class="bar"><span class="fill" [style.width.%]="(pr[k] ?? 0) * 100"></span></span>
                      } @else {
                        <button type="button" class="x" [attr.aria-label]="'attach.unpick' | t: { name: f.file.name }"
                          (click)="unpick(k)">✕</button>
                      }
                    </li>
                  }
                </ul>
              }
              @if (pending().length < maxFiles) {
                <div class="add-row">
                  <label class="add">{{ 'attach.add' | t }}
                    <input type="file" multiple hidden (change)="onPickFiles($event)" />
                  </label>
                  <span class="help">{{ 'attach.dropHint' | t }}</span>
                </div>
              } @else {
                <p class="help">{{ 'attach.max' | t: { n: '' + maxFiles } }}</p>
              }
              @if (fromDraft) { <p class="help">{{ 'attach.notInDraft' | t }}</p> }
            </div>
            @for (e of fileErrors(); track $index) {
              <p class="error" role="alert">{{ e.key | t: { name: e.name, n: '' + maxFiles } }}</p>
            }
          </div>
        }

        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        <button type="submit" class="primary" [disabled]="busy() || !ready()">{{ 'issueNew.submit' | t }}</button>
      </form>
    </main>
    @if (viewer(); as v) {
      <app-image-viewer [images]="v.list" [start]="v.index" (close)="viewer.set(null)" />
    }
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; }
    form { display: flex; flex-direction: column; gap: 16px; }
    fieldset { border: none; padding: 0; margin: 0; }
    legend, .field { font-weight: bold; font-size: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    /* 欄の見出し（太字）の中に置くので、太さだけ戻す */
    .help, .warn { font-weight: normal; }
    input, textarea { font-weight: normal; }
    .chips { margin: 4px 0 8px; }
    .link { align-self: flex-start; }
    .notice { background: var(--warning-bg); padding: 12px; border-radius: 8px; margin: 0; font-weight: normal; }
    .similar { margin-top: 4px; padding: 10px 12px; border-radius: 8px; font-weight: normal;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .similar p { margin: 0 0 6px; font-size: 13px; }
    .similar ul { list-style: none; margin: 0 0 6px; padding: 0; }
    .similar li { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 14px; }
    .similar a { flex: 1; color: var(--text); overflow-wrap: anywhere; }
    .similar .st { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--surface); white-space: nowrap; }
    .similar-help { margin: 0 !important; font-size: 12px !important; color: var(--text-muted); }
    .hours { display: flex; align-items: center; gap: 6px; font-weight: normal; }
    .hours input { width: 120px; }
    .drop { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; font-weight: normal; }
    .drop.over { outline: 2px dashed var(--primary); background: var(--primary-bg); }
    .pending { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .pending li { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px;
      background: var(--surface-alt); font-size: 13px; }
    .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .psize { font-size: 12px; color: var(--text-muted); }
    .bar { flex: 0 0 80px; height: 4px; border-radius: 2px; background: var(--surface-muted); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--primary); }
    .x { width: 28px; min-height: 28px; border: none; background: none; color: var(--text-muted); cursor: pointer; }
    .add-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
    .add { display: inline-flex; align-items: center; min-height: 36px; color: var(--primary); font-size: 14px; cursor: pointer; }
    .pthumb { flex: none; width: 40px; height: 40px; padding: 0; border: 1px solid var(--border); border-radius: 4px;
      overflow: hidden; background: var(--surface); cursor: zoom-in; }
    .pthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  `,
})
export class IssueNew implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private ps = inject(ProjectService);
  private issues = inject(IssueService);
  private authService = inject(AuthService);
  protected i18n = inject(I18nService);

  /** 開いた元のプロジェクト（プロジェクトの外から開いたときは null） */
  private readonly fromPid =
    this.route.snapshot.paramMap.get('pid') ?? this.route.snapshot.queryParamMap.get('p');
  pid = signal<string | null>(null);
  projects = signal<ProjectWithRole[]>([]);
  loadingProjects = signal(true);
  /** 受信箱のメモから来たときの、メモの id */
  private readonly memoId = this.route.snapshot.queryParamMap.get('memo');
  private inbox = inject(InboxService);
  /** 再発防止課題として作るときの、元の課題の id（詳細画面の「再発防止課題を作る」から来たとき） */
  private readonly fromIid = this.route.snapshot.queryParamMap.get('from');
  private relatedFrom: IssueLink | null = null;
  /** 複製するときの、元の課題の id（詳細画面の ⋮「複製する」から来たとき） */
  private readonly copyIid = this.route.snapshot.queryParamMap.get('copy');
  copyNumber = signal<number | null>(null);
  /** 再発として登録するときの、元の課題の id（詳細画面の「再発として新しく登録」から来たとき） */
  private readonly recurIid = this.route.snapshot.queryParamMap.get('recur');
  private recurrenceOf: { iid: string; number: number } | null = null;

  recurNumber = signal<number | null>(null);
  /** サブタスクを切り出すときの、親の課題とサブタスクの id（サブタスクの ⋮「課題に切り出す」から来たとき） */
  private readonly splitOf = this.route.snapshot.queryParamMap.get('splitOf');
  private readonly splitSub = this.route.snapshot.queryParamMap.get('sub');
  private splitFrom: { iid: string; sid: string; number: number } | null = null;
  splitNote = signal<{ n: number; title: string } | null>(null);
  fromNumber = signal<number | null>(null);
  private drafts = inject(DraftService);
  /** 下書きにできるのは、ふつうの登録だけ（メモ・再発防止・再発・切り出しは、元から開き直せば同じ中身になるため） */
  private readonly draftable = !this.memoId && !this.fromIid && !this.recurIid && !this.splitOf && !this.copyIid;
  /** この画面の下書きの id（下書きから開いたときはその id。新しく開いたときは、打ち始めたら下書きになる） */
  private readonly draftId = this.route.snapshot.queryParamMap.get('draft') ?? crypto.randomUUID();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  /** 何か触ったか（触っていなければしまわない） */
  private touched = false;
  /** 登録できた（このあとは、もうしまわない） */
  private submitted = false;
  backLink = computed(() => {
    const src = this.fromIid || this.recurIid || this.splitOf || this.copyIid;
    return this.route.snapshot.queryParamMap.get('draft') ? ['/drafts']
      : this.memoId ? ['/inbox']
      : src && this.fromPid ? ['/p', this.fromPid, 'i', src]
        : this.fromPid ? ['/p', this.fromPid] : ['/'];
  });
  readonly myUid = auth.currentUser!.uid;
  readonly types = ISSUE_TYPES;
  readonly levels: Level[] = ['high', 'mid', 'low'];
  readonly duePresets = [
    { key: 'today', days: 0 },
    { key: 'tomorrow', days: 1 },
    { key: 'in3', days: 3 },
    { key: 'in7', days: 7 },
  ];

  members = signal<Member[]>([]);
  type = signal<IssueType | null>(null);
  importance = signal<Level | null>(null);
  dueAt = signal<Date | null>(null);
  duePreset = signal<string | null>(null);
  assigneeId = signal(this.myUid);
  labelIds = signal<string[]>([]);
  /** 選んでいるプロジェクトのラベル一覧 */
  currentLabels = computed(() => this.projects().find((p) => p.id === this.pid())?.labels ?? []);
  showDetail = signal(false);
  busy = signal(false);
  error = signal('');
  title = '';
  dueInput = '';
  doneCriteria = '';
  description = '';
  occurredOn = '';
  impact = '';
  /** 工数の見積（時間。工数がオンのプロジェクトだけ） */
  estimate: number | null = null;
  /** 選んでいるプロジェクトで、工数がオンか */
  effortOn = computed(() => !!this.projects().find((p) => p.id === this.pid())?.settings?.features?.effort);
  /** 発生日に選べる最後の日（自分のタイムゾーンでの今日） */
  today = computed(() => dateKey(new Date(), this.tz()));

  // ---- 重複登録の警告 ----
  /** 選んだプロジェクトの課題と、その題名の2文字の組（プロジェクトを選んだときに1回読む） */
  private pool = signal<{ issue: Issue; grams: Set<string> }[]>([]);
  /** 打ち終わった題名（打っている途中で毎回計算しないよう、少し待ってから入れる） */
  private titleQ = signal('');
  private titleTimer: ReturnType<typeof setTimeout> | undefined;
  /** 似た課題（3件まで）。削除・統合済みと、ひも付けの元の課題は出さない */
  similar = computed(() => {
    const typed = bigrams(this.titleQ());
    if (typed.size < 3) return [];
    const skip = new Set([this.relatedFrom?.iid, this.recurrenceOf?.iid, this.splitFrom?.iid]);
    return this.pool()
      .filter((p) => p.issue.status !== 'deleted' && p.issue.status !== 'merged' && !skip.has(p.issue.id))
      .map((p) => ({ issue: p.issue, score: coverage(typed, p.grams) }))
      .filter((x) => x.score >= 0.5)
      .sort((a, b) => b.score - a.score || b.issue.updatedAt.toMillis() - a.issue.updatedAt.toMillis())
      .slice(0, 3)
      .map((x) => x.issue);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.titleTimer);
      this.flushDraft(); // 離れるときは、待たずにしまう
      // 小さな絵のために作った一時的な URL を返す
      this.pending().forEach((p) => p.url && URL.revokeObjectURL(p.url));
    });
  }

  onTitle(value: string) {
    clearTimeout(this.titleTimer);
    this.titleTimer = setTimeout(() => this.titleQ.set(value), 300);
  }

  /** プロジェクトの課題を1回読む（読めなくても登録には響かないので、警告を出さないだけ） */
  private async loadPool(pid: string) {
    this.pool.set([]);
    try {
      const list = await this.issues.listAll(pid);
      if (this.pid() !== pid) return; // 読んでいる間に別のプロジェクトに切り替えた
      this.pool.set(list.map((issue) => ({ issue, grams: bigrams(issue.title) })));
    } catch (e) {
      console.error(e);
    }
  }

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  dueLabel = computed(() => {
    const d = this.dueAt();
    return d ? formatDateTime(d, this.tz(), this.i18n.lang()) : '';
  });
  isPastDue = computed(() => {
    const d = this.dueAt();
    return !!d && d.getTime() <= Date.now();
  });

  async ngOnInit() {
    try {
      // 登録できるのは、管理者かメンバーで、アーカイブされていないプロジェクト
      const all = await this.ps.listMyProjects(this.myUid);
      const writable = all.filter((p) => !p.archived && (p.role === 'admin' || p.role === 'member'));
      this.projects.set(writable);

      // 開いた元 → 前回登録した → 一覧の先頭、の順に選ぶ
      const first = [this.fromPid, readLastProject()].find((id) => id && writable.some((p) => p.id === id))
        ?? writable[0]?.id ?? null;
      if (first) await this.selectProject(first);
      // カレンダーの日付から来たら、その日の23:59（自分のタイムゾーン）を期限に入れる
      const due = this.route.snapshot.queryParamMap.get('due');
      const m = due?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const d = zonedTime(+m[1], +m[2], +m[3], 23, 59, this.tz());
        this.dueAt.set(d);
        this.dueInput = toLocalInput(d, this.tz());
      }
      // 下書きから開いたら、その中身を入れる
      await this.restoreDraft();
      // 受信箱のメモから来たら、タイトルと内容を入れておく
      if (this.memoId) {
        const memo = await this.inbox.get(this.memoId);
        if (memo) {
          this.title = memo.title;
          if (memo.body) {
            this.description = memo.body;
            this.showDetail.set(true);
          }
        }
      }
      // 再発防止課題として作るときは、必須の欄を全部埋めておく
      if (this.fromIid && this.fromPid) await this.fillPrevention(this.fromPid, this.fromIid);
      if (this.recurIid && this.fromPid) await this.fillRecurrence(this.fromPid, this.recurIid);
      if (this.splitOf && this.splitSub && this.fromPid) await this.fillSplit(this.fromPid, this.splitOf, this.splitSub);
      if (this.copyIid && this.fromPid) await this.fillCopy(this.fromPid, this.copyIid);
      // 受信箱のメモや再発などで題名が入ったときも、似た課題を出す
      this.titleQ.set(this.title);
    } catch (e) {
      console.error(e);
    } finally {
      this.loadingProjects.set(false);
    }
  }

  /** プロジェクトを変えたら、担当者の選択肢をそのプロジェクトのメンバーに入れ替える */
  async selectProject(pid: string) {
    this.pid.set(pid);
    if (pid !== this.fromPid) {
      // 元の課題と別のプロジェクトにしたら、ひも付けはやめる（再発防止・再発は同じプロジェクトの中だけ）
      this.relatedFrom = null;
      this.fromNumber.set(null);
      this.recurrenceOf = null;
      this.recurNumber.set(null);
      this.splitFrom = null;
      this.splitNote.set(null);
    }
    // ラベルはプロジェクトごとに違うので、切り替えたら選び直してもらう
    this.labelIds.set([]);
    const all = await this.ps.listMembers(pid);
    // 閲覧者は担当者にできない
    this.members.set(all.filter((m) => m.role !== 'viewer'));
    if (!this.members().some((m) => m.uid === this.assigneeId())) {
      this.assigneeId.set(this.myUid);
    }
    this.loadPool(pid);
  }

  /**
   * 再発防止課題：必須の欄を全部埋めて、「登録する」を押すだけで済むようにする（どれも書き換えられる）。
   * 担当者は、元の担当者が今もメンバー（閲覧者以外）なら、その人
   */
  private async fillPrevention(pid: string, iid: string) {
    const src = await this.issues.get(pid, iid);
    if (!src || this.pid() !== pid) return;
    this.relatedFrom = { kind: 'prevention', iid: src.id, number: src.number };
    this.fromNumber.set(src.number);
    this.title = this.i18n.t('prevention.titlePrefix', { n: String(src.number), title: src.title }).slice(0, 200);
    this.type.set('task');
    this.importance.set(src.importance);
    this.pickPreset('in7', 7);
    if (this.members().some((m) => m.uid === src.assigneeId)) this.assigneeId.set(src.assigneeId);
    this.doneCriteria = this.i18n.t('prevention.doneCriteria');
    this.description = this.i18n.t('prevention.description', {
      n: String(src.number), title: src.title, cause: src.cause ?? '', countermeasure: src.countermeasure ?? '',
    });
    this.showDetail.set(true);
  }

  /**
   * 再発：題名・種別・重要度・内容を元の課題から入れる。担当者は自分（見つけた人が起票するため）。
   * 期限は入れない（いつまでに直すかは、そのときの状況で人が決める）
   */
  private async fillRecurrence(pid: string, iid: string) {
    const src = await this.issues.get(pid, iid);
    if (!src || this.pid() !== pid) return;
    this.recurrenceOf = { iid: src.id, number: src.number };
    this.recurNumber.set(src.number);
    this.title = this.i18n.t('links.recurTitle', { n: String(src.number), title: src.title }).slice(0, 200);
    this.selectType(src.type); // 完了条件の初期文も、種別に合わせて入る
    this.importance.set(src.importance);
    this.description = this.i18n.t('links.recurDescription', {
      n: String(src.number), title: src.title, cause: src.cause ?? '', countermeasure: src.countermeasure ?? '',
    });
    this.showDetail.set(true);
  }

  /**
   * 切り出し：題名はサブタスクのまま。種別・重要度は親と同じ（赤G）、期限はサブタスクの期限、なければ親の期限（赤H）。
   * 担当者は、サブタスクの担当者が今もメンバーならその人
   */
  private async fillSplit(pid: string, iid: string, sid: string) {
    const [src, sub] = await Promise.all([this.issues.get(pid, iid), this.issues.getSubtask(pid, iid, sid)]);
    if (!src || !sub || sub.splitTo || this.pid() !== pid) return;
    this.splitFrom = { iid: src.id, sid: sub.id, number: src.number };
    this.splitNote.set({ n: src.number, title: sub.title });
    this.title = sub.title;
    this.selectType(src.type); // 完了条件の初期文も、種別に合わせて入る
    this.importance.set(src.importance);
    const due = (sub.dueAt ?? src.dueAt).toDate();
    this.dueAt.set(due);
    this.dueInput = toLocalInput(due, this.tz());
    this.duePreset.set(null);
    if (this.members().some((m) => m.uid === sub.assigneeId)) this.assigneeId.set(sub.assigneeId);
    this.description = this.i18n.t('subtask.splitDescription', {
      n: String(src.number), title: src.title, memo: sub.memo,
    }).trimEnd() + '\n';
    this.showDetail.set(true);
  }

  // ---- 添付（登録するまで手元にためておき、登録したあとに上げる） ----
  private attachments = inject(AttachmentService);
  readonly maxFiles = MAX_ATTACHMENTS;
  /** 下書きから開いたか（ファイルは下書きに残らないことを知らせるため） */
  readonly fromDraft = !!this.route.snapshot.queryParamMap.get('draft');
  /** ためたファイルと、画像なら手元で作った一時的な URL（小さな絵に使う。外したとき・離れるときに返す） */
  pending = signal<{ file: File; url: string | null }[]>([]);
  viewer = signal<{ list: ViewerImage[]; index: number } | null>(null);

  /** 選んだ画像を、上げる前に大きく見る */
  viewPending(k: number) {
    const list = this.pending()
      .map((p, j) => ({ id: String(j), name: p.file.name, url: p.url ?? '' }))
      .filter((x) => x.url);
    this.viewer.set({ list, index: Math.max(0, list.findIndex((x) => x.id === String(k))) });
  }
  /** 上げている途中の進み具合（ファイルごと。上げる前は null） */
  progress = signal<number[] | null>(null);
  fileErrors = signal<{ key: string; name: string }[]>([]);
  over = signal(false);

  size(n: number) {
    return sizeText(n);
  }

  onPickFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const list = Array.from(input.files ?? []);
    input.value = ''; // 同じファイルを選び直しても、選んだことになるように
    this.addFiles(list);
  }

  onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); // これがないと、ブラウザがファイルを開いてしまう
    this.over.set(true);
  }

  onDrop(e: DragEvent) {
    const list = Array.from(e.dataTransfer?.files ?? []);
    this.over.set(false);
    if (!list.length) return;
    e.preventDefault();
    this.addFiles(list);
  }

  /** 数・大きさ・種類を、ためる前に確かめる（課題の詳細の添付と同じ決まり） */
  private addFiles(list: File[]) {
    this.fileErrors.set([]);
    for (const f of list) {
      if (this.pending().length >= MAX_ATTACHMENTS) {
        this.fileErrors.update((x) => [...x, { key: 'attach.max', name: f.name }]);
        break;
      }
      const bad = checkFile(f);
      if (bad) this.fileErrors.update((x) => [...x, { key: 'attach.' + bad, name: f.name }]);
      else this.pending.update((p) => [...p, { file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }]);
    }
  }

  unpick(k: number) {
    const url = this.pending()[k]?.url;
    if (url) URL.revokeObjectURL(url); // 一時的な URL を返す（返さないと、メモリに残り続ける）
    this.pending.update((p) => p.filter((_, j) => j !== k));
  }

  /** できた課題に、ためたファイルを上げる（同時に進む）。上げられなかったファイルの名前を返す */
  private async uploadPending(pid: string, iid: string): Promise<string[]> {
    const list = this.pending();
    if (!list.length) return [];
    this.progress.set(list.map(() => 0));
    const results = await Promise.allSettled(list.map((x, k) => this.attachments.upload(
      pid, iid, x.file, this.myUid, this.tz(), {
        onProgress: (p) => this.progress.update((all) => all && all.map((x, j) => (j === k ? p : x))),
      })));
      return results.flatMap((r, k) => (r.status === 'rejected' ? [list[k].file.name] : []));
  }  

  /**
   * 複製：中身を元の課題から入れる。期限は入れない（新しい課題の期限は、そのとき決めるもの）。
   * 担当者は、今もメンバー（閲覧者以外）ならその人。ラベルは今もプロジェクトにあるものだけ
   */
  private async fillCopy(pid: string, iid: string) {
    const src = await this.issues.get(pid, iid);
    if (!src || this.pid() !== pid) return;
    this.copyNumber.set(src.number);
    this.title = this.i18n.t('copy.title', { title: src.title }).slice(0, 200);
    this.type.set(src.type);
    this.importance.set(src.importance);
    if (this.members().some((m) => m.uid === src.assigneeId)) this.assigneeId.set(src.assigneeId);
    this.doneCriteria = src.doneCriteria;
    this.description = src.description;
    const ok = new Set(this.currentLabels().map((l) => l.id));
    this.labelIds.set((src.labelIds ?? []).filter((l) => ok.has(l)));
    this.impact = src.impact ?? '';
    this.estimate = src.estimateHours ?? null;
    this.showDetail.set(true);
  }

  /** 何か触ったら、少し待ってから下書きにしまう（1文字ごとに書き込まないように） */
  touch() {
    if (!this.draftable || this.submitted) return;
    this.touched = true;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft(), 400);
  }

  /** 今の中身を下書きにしまう。空なら下書きを消す（空の下書きをためない） */
  private flushDraft() {
    clearTimeout(this.draftTimer);
    if (!this.draftable || this.submitted || !this.touched) return;
    const v: IssueDraft = {
      pid: this.pid(), title: this.title, type: this.type(), importance: this.importance(),
      dueMs: this.dueAt()?.getTime() ?? null, assigneeId: this.assigneeId(),
      doneCriteria: this.doneCriteria, description: this.description, labelIds: this.labelIds(),
      occurredOn: this.occurredOn, impact: this.impact, showDetail: this.showDetail(),      
      estimate: this.estimate,
    };
    const empty = !v.title.trim() && !v.type && !v.importance && v.dueMs == null && !v.doneCriteria.trim()
    && !v.description.trim() && !v.labelIds.length && !v.occurredOn && !v.impact.trim() && v.estimate == null;
    if (empty) this.drafts.remove(this.draftId);
    else this.drafts.save({ id: this.draftId, kind: 'issue', title: v.title.trim(), pid: v.pid, data: v });
  }

  /**
   * 下書きから開いたときに、中身を入れる。プロジェクトが今も登録できるものなら、そちらに切り替えてから。
   * 期限は日時そのものを戻す（「今日中」は書いた日の今日なので、選んだボタンではなく日時で戻す）
   */
  private async restoreDraft() {
    const id = this.route.snapshot.queryParamMap.get('draft');
    const d = id ? this.drafts.get(id) : null;
    if (!d || d.kind !== 'issue') return;
    const v = d.data as IssueDraft;
    if (v.pid && v.pid !== this.pid() && this.projects().some((p) => p.id === v.pid)) await this.selectProject(v.pid);
    this.title = v.title;
    this.type.set(v.type);
    this.importance.set(v.importance);
    if (v.dueMs != null) {
      const due = new Date(v.dueMs);
      this.dueAt.set(due);
      this.dueInput = toLocalInput(due, this.tz());
      this.duePreset.set(null);
    }
    // 担当者が抜けていたら自分のまま。ラベルは、今もプロジェクトにあるものだけ
    if (this.members().some((m) => m.uid === v.assigneeId)) this.assigneeId.set(v.assigneeId);
    this.doneCriteria = v.doneCriteria;
    this.description = v.description;
    const ok = new Set(this.currentLabels().map((l) => l.id));
    this.labelIds.set(v.labelIds.filter((l) => ok.has(l)));
    this.occurredOn = v.occurredOn;
    this.impact = v.impact;
    this.showDetail.set(v.showDetail);
    this.estimate = v.estimate ?? null;
  }

  selectType(t: IssueType) {
    const prev = this.type();
    // 雛形のまま（未編集）なら差し替える。自分で書き換えた内容は消さない
    const untouched = (value: string, prefix: string) =>
      !value.trim() || (prev !== null && value === this.i18n.t(prefix + prev));
    if (untouched(this.doneCriteria, 'doneCriteria.')) this.doneCriteria = this.i18n.t('doneCriteria.' + t);
    if (untouched(this.description, 'descTemplate.')) this.description = this.i18n.t('descTemplate.' + t);
    this.type.set(t);
  }

  pickPreset(key: string, days: number) {
    this.duePreset.set(key);
    this.dueInput = '';
    this.dueAt.set(endOfDayIn(days, this.tz()));
  }

  onDueInput(value: string) {
    this.dueInput = value;
    this.duePreset.set(null);
    this.dueAt.set(parseLocalInput(value, this.tz()));
  }

  ready() {
    return !!(this.pid() && this.title.trim() && this.type() && this.importance() && this.dueAt()
      && this.doneCriteria.trim() && this.assigneeId());
  }

  async save() {
    if (!this.ready()) return;
    const estimateHours = this.effortOn() ? toHours(this.estimate) : null;
    if (estimateHours === undefined) {
      this.error.set('effort.invalid');
      return;
    }

    this.busy.set(true);
    this.error.set('');
    try {
      const pid = this.pid()!;
      const { iid } = await this.issues.create(pid, {
        title: this.title.trim(),
        type: this.type()!,
        importance: this.importance()!,
        dueAt: this.dueAt()!,
        assigneeId: this.assigneeId(),
        doneCriteria: this.doneCriteria.trim(),
        description: this.description,
        labelIds: this.labelIds(),
        occurredOn: this.occurredOn || null,
        impact: this.impact.trim(),
        estimateHours,
        relatedFrom: this.relatedFrom,
        recurrenceOf: this.recurrenceOf,
        splitFrom: this.splitFrom,
      }, this.myUid, this.tz(), this.memoId ?? undefined);
      writeLastProject(pid);
      // 登録できたので、下書きは要らない（このあと画面を離れても、しまい直さない）
      this.submitted = true;
      clearTimeout(this.draftTimer);
      this.drafts.remove(this.draftId);
      // 課題ができてから、ためたファイルを上げる（添付の一覧は課題の下に作るので、課題が先に要る）
      const failed = await this.uploadPending(pid, iid);
      if (failed.length) {
        // 課題はできているので作り直させず、その課題の詳細へ移って、詳細からもう一度添付してもらう
        await this.router.navigate(['/p', pid, 'i', iid], { state: { attachFailed: failed } });
        return;
      }
      // 切り出したときは、親の課題に戻る（切り出し済みになったことを、その場で確かめられるように）
      await this.router.navigate(this.splitFrom ? ['/p', pid, 'i', this.splitFrom.iid] : ['/p', pid]);
    } catch (e) {
      console.error(e);
      this.error.set((e as Error).message === 'split-gone' ? 'subtask.splitGone' : 'common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}