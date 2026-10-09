import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { IssueService } from '../../core/issue/issue.service';
import { ISSUE_TYPES, IssueType, Level, Member, ProjectWithRole } from '../../core/models';
import { endOfDayIn, formatDateTime, parseLocalInput, toLocalInput, zonedTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { HelpTip } from '../../shared/help-tip';
import { LabelPicker } from '../../shared/label-picker';

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

@Component({
  selector: 'app-issue-new',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelPicker],
  template: `
    <header class="bar"><a [routerLink]="backLink()" class="link">{{ 'common.back' | t }}</a></header>
    <main>
      <h1>{{ 'issueNew.title' | t }}</h1>
      <form (ngSubmit)="save()">
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
          <input id="f-title" name="title" [(ngModel)]="title" maxlength="200" required autofocus
            [placeholder]="'issueNew.titlePlaceholder' | t" />
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

        <fieldset>
          <legend>{{ 'issue.assignee' | t }}</legend>
          <div class="chips">
            @for (m of members(); track m.uid) {
              <button type="button" [class.on]="assigneeId() === m.uid" [attr.aria-pressed]="assigneeId() === m.uid"
                (click)="assigneeId.set(m.uid)">
                {{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}
              </button>
            }
          </div>
        </fieldset>

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
        }

        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        <button type="submit" class="primary" [disabled]="busy() || !ready()">{{ 'issueNew.submit' | t }}</button>
      </form>
    </main>
  `,
  styles: `
    .bar { padding: 8px 16px; border-bottom: 1px solid var(--border); }
    main { max-width: 640px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 20px; }
    form { display: flex; flex-direction: column; gap: 16px; }
    fieldset { border: none; padding: 0; margin: 0; }
    legend, .field { font-weight: bold; font-size: 14px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .help { font-weight: normal; font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    input, textarea, button { font-size: 16px; }
    input, button { min-height: 48px; }
    input, textarea { padding: 8px 12px; font-weight: normal; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 8px; }
    .chips button { padding: 0 16px; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 24px; }
    .chips button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .link { background: none; border: none; color: var(--primary); align-self: flex-start; }
    .primary { background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; }
    .primary:disabled { background: var(--disabled); }
    .error { color: var(--danger-text); }
        select { min-height: 48px; font-size: 16px; padding: 0 12px; }
    .notice { background: var(--warning-bg); padding: 12px; border-radius: 8px; margin: 0; font-weight: normal; }
    .warn { margin: 4px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-weight: normal;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
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
  backLink = computed(() => (this.fromPid ? ['/p', this.fromPid] : ['/']));
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
    } catch (e) {
      console.error(e);
    } finally {
      this.loadingProjects.set(false);
    }
  }

  /** プロジェクトを変えたら、担当者の選択肢をそのプロジェクトのメンバーに入れ替える */
  async selectProject(pid: string) {
    this.pid.set(pid);
    // ラベルはプロジェクトごとに違うので、切り替えたら選び直してもらう
    this.labelIds.set([]);
    const all = await this.ps.listMembers(pid);
    // 閲覧者は担当者にできない
    this.members.set(all.filter((m) => m.role !== 'viewer'));
    if (!this.members().some((m) => m.uid === this.assigneeId())) {
      this.assigneeId.set(this.myUid);
    }
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

    this.busy.set(true);
    this.error.set('');
    try {
      const pid = this.pid()!;
      await this.issues.create(pid, {
        title: this.title.trim(),
        type: this.type()!,
        importance: this.importance()!,
        dueAt: this.dueAt()!,
        assigneeId: this.assigneeId(),
        doneCriteria: this.doneCriteria.trim(),
        description: this.description,
        labelIds: this.labelIds(),
      }, this.myUid, this.tz());
      writeLastProject(pid);
      await this.router.navigate(['/p', pid]);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}