import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { FirestoreError, Unsubscribe } from 'firebase/firestore';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Location } from '@angular/common';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { ProjectService } from '../../core/project/project.service';
import {
  ConflictError, EMPTY_STATUS_PAYLOAD, IssueEdits, IssueService, conflictWho,
} from '../../core/issue/issue.service';
import { enterKey, focusById } from '../../core/dom';
import { LabelPicker } from '../../shared/label-picker';
import {
  CAUSE_CATEGORIES, CauseCategory, DEFAULT_SETTINGS, Issue, IssueRelation, Label, Level, Member, Project, Role,
  TimelineItem, labelsOf, OPEN_STATUSES, hasWorkaround, ISSUE_TYPES
} from '../../core/models';
import { LinkDialog } from './link-dialog';
import { StatusDialog } from '../../shared/status-dialog';
import { LabelChip } from '../../shared/label-chip';
import { HelpTip } from '../../shared/help-tip';
import { PriorityMark } from '../../shared/priority-mark';
import { isStale, priorityOf } from '../../core/issue/priority';
import { dateKey, endOfDayIn, formatDateTime, parseLocalInput, remainingOf, toLocalInput } from '../../core/time/time';
import { MemberSelect } from '../../shared/member-select';
import { Transition, availableTransitions } from '../../core/issue/workflow';
import { I18nService, TPipe } from '../../i18n/i18n';
import { MergeDialog } from './merge-dialog';
import { SubtaskList } from './subtask-list';


/** 経緯の「編集した欄」の項目名 → 翻訳キー（issue.〇〇）。名前が違うものだけ書く */
const FIELD_LABEL_KEYS: Record<string, string> = { assigneeId: 'assignee', dueAt: 'due' };
/** 関連課題の欄の並び（種類と向きの組。「関連」は向きを分けない） */
const LINK_GROUPS = [
  'waitsFor_out', 'waitsFor_in', 'recurrence_out', 'recurrence_in', 'duplicate_out', 'duplicate_in', 'relates',
];
function linkGroupOf(kind: string, dir: string) {
  return kind === 'relates' ? 'relates' : `${kind}_${dir}`;
}

/** その場編集で、1つの欄が2つの課題で同じかを比べる（衝突のとき「同じ欄がぶつかったか」を見るため） */
function sameField(k: keyof IssueEdits, a: Issue, b: Issue): boolean {
  switch (k) {
    case 'dueAt': return a.dueAt.isEqual(b.dueAt);
    case 'labelIds': return [...(a.labelIds ?? [])].sort().join() === [...(b.labelIds ?? [])].sort().join();
    case 'occurredOn': return (a.occurredOn ?? null) === (b.occurredOn ?? null);
    case 'impact': return (a.impact ?? '') === (b.impact ?? '');
    default: return a[k as keyof Issue] === b[k as keyof Issue];
  }
}

@Component({
  selector: 'app-issue-detail',
  imports: [FormsModule, RouterLink, TPipe, HelpTip, LabelChip, StatusDialog, PriorityMark, LinkDialog,
    MergeDialog, LabelPicker, MemberSelect, SubtaskList],
  host: {
    '(document:keydown.escape)':
      'menuOpen.set(false); statusMenu.set(false); prioMenu.set(false); typeMenu.set(false); closeField()',
    '(document:click)': 'onDocClick($event)',
  },
  templateUrl: './issue-detail.html',
  styleUrl: './issue-detail.css',
})
export class IssueDetail implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private authService = inject(AuthService);
  private clock = inject(Clock);
  protected i18n = inject(I18nService);

  readonly pid = this.route.snapshot.paramMap.get('pid')!;
  readonly iid = this.route.snapshot.paramMap.get('iid')!;
  readonly myUid = auth.currentUser!.uid;
  readonly levels: Level[] = ['high', 'mid', 'low'];

  // 編集と優先度の手動変更
  prioPanel = signal(false);
  prioChoice = signal<Level | 'auto' | null>(null);
  prioReason = '';
  /** 優先度のパネルを開いた時点の課題（衝突のあとは最新） */
  private prioBase = signal<Issue | null>(null);
  /** 優先度の保存で衝突した（blocked＝クローズ・却下されて、もう変えられない） */
  prioConflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 入力の要らないステータス変更で衝突したときの、最新の課題 */
  actionConflict = signal<Issue | null>(null);
  // 削除
  delPanel = signal(false);
  delReason = '';
  /** 削除のパネルを開いた時点の課題（衝突のあとは最新） */
  private delBase = signal<Issue | null>(null);
  delConflict = signal<Issue | null>(null);
  // 原因・対策（対応中・保留のときの下書き）
  readonly causeCategories = CAUSE_CATEGORIES;
  causePanel = signal(false);
  causeText = '';
  counterText = '';
  causeCat = signal<CauseCategory | null>(null);
  /** パネルを開いた時点の課題（衝突のあとは最新） */
  private causeBase = signal<Issue | null>(null);
  /** 保存で衝突した（blocked＝対応中・保留ではなくなって、もう書けない） */
  causeConflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  // 回避策
  waPanel = signal(false);
  waText = '';
  private waBase = signal<Issue | null>(null);
  waConflict = signal<{ latest: Issue; blocked: boolean } | null>(null);
  /** 保存したあと、重要度の見直しをすすめる（中身があり、重要度が「小」でないときだけ） */
  waSaved = signal(false);
  waEndError = signal('');
  workaroundOn = computed(() => {
    const i = this.issue();
    return !!i && hasWorkaround(i);
  });
  /** 回避策を書けるか：担当者と管理者（アーカイブ中は不可） */
  canEditWorkaround = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || !this.isActive(i) || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });

  issue = signal<Issue | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  timeline = signal<TimelineItem[]>([]);
  /** 経緯の絞り込み（すべて／コメントだけ） */
  tlFilter = signal<'all' | 'comments'>('all');
  /** たたんだ途中を開いたか */
  tlExpanded = signal(false);
  /**
   * 表示する経緯：長いときは、最初の3件と最新の10件を出し、間を1行にたたむ。
   * 開いたあとは、同じ場所に「途中をたたむ」を出す。
   * 中で別のスクロールを作らない（画面のスクロールの中にもう1つあると、スマホで迷うため）
   */
  timelineView = computed<(
    TimelineItem | { kind: 'fold'; id: string; n: number } | { kind: 'unfold'; id: string; n: number }
  )[]>(() => {
    const list = this.tlFilter() === 'comments'
      ? this.timeline().filter((t) => t.kind === 'comment')
      : this.timeline();
    const head = 3;
    const tail = 10;
    // たたんでも2件しか隠れないなら、たたまない（押す手間のほうが大きいため）
    if (list.length <= head + tail + 2) return list;
    const n = list.length - head - tail;
    return this.tlExpanded()
      ? [...list.slice(0, head), { kind: 'unfold' as const, id: 'unfold', n }, ...list.slice(head)]
      : [...list.slice(0, head), { kind: 'fold' as const, id: 'fold', n }, ...list.slice(-tail)];
  });
  projectLabels = signal<Label[]>([]);
  issueLabels = computed(() => labelsOf(this.issue()?.labelIds, this.projectLabels()));
  /** 役割・メンバー・プロジェクトの読み込み中 */
  private metaLoading = signal(true);
  /** 課題の最初の版が届いたか */
  private issueReady = signal(false);
  loading = computed(() => this.metaLoading() || !this.issueReady());
  private stops: Unsubscribe[] = [];
  /** モーダル（ステータス変更）を開いた時点の課題。開いている間に変更が届いても、入力の土台は変えない */
  base = signal<Issue | null>(null);

  constructor() {
    // 詳細画面を離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => {
      this.stops.forEach((stop) => stop());
      this.linkStops.forEach((stop) => stop());
      clearTimeout(this.flashTimer);
    });
  }
  busy = signal(false);
  error = signal('');

  // ステータス変更の入力
  // ステータス変更のモーダル（入力が要るものだけ開く）
  active = signal<Transition | null>(null);
  comment = '';
  // コメントのその場での編集
  editingId = signal<string | null>(null);
  editBody = '';
  /** アーカイブ中のプロジェクトでは、コメントの編集・削除のボタンを出さない */
  projectArchived = signal(false);
  /** この課題を元に作られた再発防止課題 */
  preventions = signal<Issue[]>([]);
  // ---- 関連課題 ----
  relations = signal<IssueRelation[]>([]);
  /** 相手の課題（キーは「pid/iid」。null＝読めない・見つからない。まだ届いていなければキーがない） */
  private linked = signal<Record<string, Issue | null>>({});
  private linkStops = new Map<string, Unsubscribe>();
  /** ほかのプロジェクトの名前（読めたものだけ） */
  projectNames = signal<Record<string, string>>({});
  linkOpen = signal(false);
  linkError = signal('');
  /** 付けられるのは、管理者とメンバー（アーカイブ中・削除フォルダの中は不可） */
  canLink = computed(() => this.canCreate() && this.issue()?.status !== 'deleted');
  linkGroups = computed(() => LINK_GROUPS
    .map((key) => ({ key, rels: this.relations().filter((r) => linkGroupOf(r.kind, r.dir) === key) }))
    .filter((g) => g.rels.length));
  /** 保留中に、理由の下に出す「完了待ち」（こちらから付けたもの） */
  waitingFor = computed(() => this.relations().filter((r) => r.kind === 'waitsFor' && r.dir === 'out'));
  /** 再発防止課題を作れるか：管理者とメンバー（アーカイブ中は不可） */
  canCreate = computed(() => (this.role() === 'admin' || this.role() === 'member') && !this.projectArchived());
  /** 停滞とみなす日数（開いたときにプロジェクトの設定から読む） */
  staleDays = signal(DEFAULT_SETTINGS.staleDays);
  stale = computed(() => {
    const i = this.issue();
    return !!i && isStale(i, this.staleDays(), this.clock.now());
  });
  /** 上の道しるべと、外されたときの知らせに使うプロジェクト名 */
  projectName = signal('');
  /** 外れた人の名前（uid → 名前） */
  private formerMembers: Record<string, string> = {};

  tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  priority = computed(() => priorityOf(this.issue()!, this.clock.now()));
  autoPriority = computed(() => priorityOf({ ...this.issue()!, priorityOverride: null }, this.clock.now()));
  canEdit = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || i.status === 'closed' || i.status === 'merged' || this.projectArchived()) return false;
    if (r === 'admin') return true;
    return r === 'member' && (i.reporterId === this.myUid || i.assigneeId === this.myUid);
  });

  /** サブタスクを全部触れるか（親の課題を編集できる人。削除フォルダの中は不可） */
  canEditSubtasks = computed(() => this.canEdit() && this.issue()?.status !== 'deleted');
  /** 自分が担当のサブタスクの □ を押せるか（管理者・メンバーで、親がまだ動いている） */
  canWork = computed(() => {
    const s = this.issue()?.status;
    const r = this.role();
    return (r === 'admin' || r === 'member') && !this.projectArchived()
      && !!s && !['closed', 'deleted', 'merged'].includes(s);
  });
  /** サブタスクの部品に渡す名前の引き方（テンプレートでは矢印関数が書けないので、ここで作る） */
  readonly nameFn = (uid: string) => this.memberName(uid);

  canSetPriority = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || !this.isActive(i) || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });

  /** 原因・対策のボタンを出すか（対応中・保留のときだけ） */
  showCauseButton = computed(() => {
    const s = this.issue()?.status;
    return s === 'in_progress' || s === 'on_hold';
  });
  /** 原因・対策を書けるか：担当者と管理者（アーカイブ中は不可） */
  canEditCause = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || !r || !this.showCauseButton() || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.assigneeId === this.myUid);
  });


  /** 削除は管理者だけ（アーカイブ中は不可） */
  canDelete = computed(() => this.role() === 'admin' && !this.projectArchived());

  /** 統合のボタンを出すか：未クローズのときだけ */
  showMerge = computed(() => {
    const s = this.issue()?.status;
    return !!s && OPEN_STATUSES.includes(s);
  });
  /** 統合は管理者だけ（アーカイブ中は不可） */
  canMerge = computed(() => this.showMerge() && this.role() === 'admin' && !this.projectArchived());
  mergeOpen = signal(false);

  /** ⋮ のメニュー */
  menuOpen = signal(false);
  statusMenu = signal(false);
  prioMenu = signal(false);
  // ---- その場編集 ----
  readonly types = ISSUE_TYPES;
  typeMenu = signal(false);
  /** 今入力中の欄（null＝どれも開いていない） */
  editField = signal<string | null>(null);
  /** 欄を開いた時点の課題（衝突のあとは最新） */
  private editBase = signal<Issue | null>(null);
  /** 同じ欄をほかの人が先に変えていた（中身は最新の課題） */
  fieldConflict = signal<Issue | null>(null);
  fieldError = signal('');
  /** 入力中の値（どの欄も1つずつしか開かないので、入れ物は共通） */
  draftText = '';
  draftDate = '';
  draftLabels = signal<string[]>([]);
  draftAssignee = signal('');
  draftDue = signal<Date | null>(null);
  draftDueInput = '';
  draftReason = '';
  /** 外を押したのに理由が書いてない（理由の欄に注意を出す） */
  reasonNeeded = signal(false);
  readonly duePresets = [
    { key: 'today', days: 0 }, { key: 'tomorrow', days: 1 }, { key: 'in3', days: 3 }, { key: 'in7', days: 7 },
  ];
  /** 担当者にできる人（閲覧者は担当者になれない） */
  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));
  assigneeChanged = computed(() => this.draftAssignee() !== this.editBase()?.assigneeId);
  dueChanged = computed(() => {
    const d = this.draftDue();
    return !!d && d.getTime() !== this.editBase()?.dueAt.toMillis();
  });
  /** 変えた期限が、今より前か（赤い「期限切れとして確定」にする） */
  duePast = computed(() => this.dueChanged() && this.draftDue()!.getTime() <= this.clock.now());
  /** 発生日に選べる最後の日（自分のタイムゾーンの今日） */
  todayKey = computed(() => dateKey(new Date(this.clock.now()), this.tz()));
  /** 衝突の知らせの文（だれが＋どうすればよいか） */
  conflictText = computed(() => {
    const c = this.fieldConflict();
    if (!c) return '';
    const w = this.who(c);
    return `${this.i18n.t(w.key, w.params)} ${this.i18n.t(this.editField() ? 'field.conflictText' : 'field.conflictPick')}`;
  });
  /** 下に数秒だけ出す知らせ（翻訳キー） */
  flash = signal('');
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** 再発防止のすすめ：クローズで、効果が一部・なしのとき */
  showRecommend = computed(() => {
    const i = this.issue();
    return !!i && (i.status === 'resolved' || i.status === 'closed') && (i.effect === 'partial' || i.effect === 'no');
  });

  /** 復元は、管理者と、提起した本人（メンバー） */
  canRestore = computed(() => {
    const i = this.issue();
    const r = this.role();
    if (!i || this.projectArchived()) return false;
    return r === 'admin' || (r === 'member' && i.reporterId === this.myUid);
  });

  toolDenied = computed(() => [
    ...(this.showCauseButton() && !this.canEditCause() ? ['causeEdit.denied'] : []),
    ...(this.issue() && this.isActive(this.issue()!) && !this.workaroundOn() && !this.canEditWorkaround()
      ? ['workaround.denied'] : []),
  ]);
  overdue = computed(() => this.issue()!.dueAt.toMillis() < this.clock.now());
  dueText = computed(() => {
    const r = remainingOf(this.issue()!.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  });
  dueLabel = computed(() => formatDateTime(this.issue()!.dueAt.toDate(), this.tz(), this.i18n.lang()));
  transitions = computed(() => {
    const i = this.issue();
    const r = this.role();
    return i && r && !this.projectArchived() ? availableTransitions(i, r, this.myUid) : [];
  });
  /** 押せないボタンがあるときの理由（重複なし） */
  deniedReasons = computed(() => [
    ...new Set(this.transitions().filter((a) => !a.allowed).map((a) => 'workflow.denied.' + a.t.who)),
  ]);
  /** 却下か差し戻しのボタンが並ぶときだけ、違いの説明を出す */
  showRejectHelp = computed(() => this.transitions().some((a) => a.t.key === 'reject' || a.t.key === 'sendBack'));

  async ngOnInit() {
    // 見張りを先に始めて、役割などの読み込みと並行して届くようにする
    this.watch();
    await this.load();
  }

  /** 課題と経緯は見張る。他の人の変更も、届くたびに画面に出る */
  private watch() {
    this.stops.push(
      this.issueService.watchIssue(
        this.pid, this.iid,
        (issue) => {
          this.issue.set(issue);
          this.issueReady.set(true);
        },
        (e) => {
          this.issue.set(null);
          this.issueReady.set(true);
          this.onWatchError(e);
        },
      ),
      this.issueService.watchTimeline(this.pid, this.iid, (items) => this.timeline.set(items), (e) => console.error(e)),
      this.issueService.watchRelatedTo(this.pid, this.iid, (list) => this.preventions.set(list), (e) => console.error(e)),
      this.issueService.watchLinks(this.pid, this.iid, (rels) => {
        this.relations.set(rels);
        this.syncLinked(rels);
      }, (e) => console.error(e)),
    );
  }

  /** 役割とメンバーは見張る。プロジェクト（ラベル・アーカイブ）は開いたときに1回読む */
  async load() {
    try {
      // メンバーでなければ、ここでルールに止められて例外になる
      this.role.set(await this.ps.myRole(this.pid, this.myUid));
      // どちらも、最初の1回が届くまで待つ
      await Promise.all([this.watchProject(), this.watchMembers()]);
    } catch (e) {
      console.error(e);
      this.issue.set(null);
    } finally {
      this.metaLoading.set(false);
    }
  }

  /** プロジェクトを見張る。設定やラベルを変えたら、開いたままでも反映する。最初の1回が届いたら知らせる */
  private watchProject() {
    return new Promise<void>((resolve, reject) => {
      this.stops.push(this.ps.watchProject(
        this.pid,
        (project) => {
          if (project?.deleting) {
            this.lostAccess(true);
            return;
          }
          this.applyProject(project);
          resolve(); // 2回目以降に呼ばれても何も起きない
        },
        (e) => {
          this.onWatchError(e);
          reject(e);
        },
      ));
    });
  }

  private applyProject(project: Project | null) {
    this.projectLabels.set(project?.labels ?? []);
    this.projectArchived.set(project?.archived ?? false);
    this.staleDays.set(project?.settings?.staleDays ?? DEFAULT_SETTINGS.staleDays);
    this.projectName.set(project?.name ?? '');
    this.formerMembers = project?.formerMembers ?? {};
  }

  /** メンバーを見張る。最初の1回が届いたら、待っている load() に知らせる */
  private watchMembers() {
    return new Promise<void>((resolve, reject) => {
      this.stops.push(this.ps.watchMembers(
        this.pid,
        (members) => {
          this.applyMembers(members);
          resolve();
        },
        (e) => {
          this.onWatchError(e);
          reject(e);
        },
      ));
    });
  }

  /** 自分の役割も、メンバー一覧から取り直す */
  private applyMembers(members: Member[]) {
    const me = members.find((m) => m.uid === this.myUid);
    if (!me) {
      this.lostAccess();
      return;
    }
    this.members.set(members);
    this.role.set(me.role);
  }

  /** 開き終わったあとに読めなくなった＝メンバーから外された（開く前なら「見つからない」のまま） */
  private onWatchError(e: FirestoreError) {
    console.error(e);
    if (e.code === 'permission-denied' && !this.metaLoading()) this.lostAccess();
  }

  /** 外されたら、ホームへ戻して知らせる（「戻る」で見られない画面に戻らないよう、履歴を置き換える） */
  private lostAccess(gone = false) {
    // 見張りが複数あるので、外されたときは知らせが何回か来うる。止めたあと（stops が空）なら何もしない
    if (!this.stops.length) return;
    this.stops.forEach((stop) => stop());
    this.stops = [];
    this.router.navigate(['/'], {
      replaceUrl: true,
      state: gone ? { deletedProject: this.projectName() } : { removedFrom: this.projectName() },
    });
  }

  click(t: Transition) {
    this.actionConflict.set(null);
    if (t.needs === 'none') {
      this.applyNow(t);
      return;
    }
    this.base.set(this.issue());
    this.active.set(t);
  }

  /** 欄を開く。ほかの欄を開いていたら、先にそちらを保存して閉じる（閉じられなければ開かない） */
  async openField(f: string) {
    const current = this.editField();
    if (current === f) return;
    if (current && !(await this.leaveField())) return;
    const i = this.issue()!;
    this.editBase.set(i);
    this.fieldConflict.set(null);
    this.fieldError.set('');
    this.reasonNeeded.set(false);
    const texts: Record<string, string> = {
      title: i.title, description: i.description, doneCriteria: i.doneCriteria, impact: i.impact ?? '',
    };
    this.draftText = texts[f] ?? '';
    this.draftDate = i.occurredOn ?? '';
    this.draftLabels.set(i.labelIds ?? []);
    this.draftAssignee.set(i.assigneeId);
    this.draftDue.set(i.dueAt.toDate());
    this.draftDueInput = toLocalInput(i.dueAt.toDate(), this.tz());
    this.draftReason = '';
    this.editField.set(f);
    setTimeout(() => focusById('e-' + f));
  }

  closeField() {
    this.editField.set(null);
    this.fieldConflict.set(null);
  }

  /** 入力欄の外を押したとき（押したのが、ほかの欄の文字やメニューなら、そちらに任せる） */
  onDocClick(e: MouseEvent) {
    if (!this.editField()) return;
    const t = e.target as Element | null;
    if (!t || t.closest('.inline-edit, .text-btn, .menu, .backdrop, app-help-tip, [role="dialog"]')) return;
    this.leaveField();
  }

  /**
   * 欄から離れる：変えていなければ閉じる、変えていれば保存して閉じる。
   * 期限・担当者を変えたのに理由が無ければ、閉じずに理由の欄へ（勝手に捨てない・勝手に理由なしで保存しない）
   */
  async leaveField(): Promise<boolean> {
    const f = this.editField();
    if (!f) return true;
    if (this.busy()) return false;
    const needs = (f === 'due' && this.dueChanged()) || (f === 'assignee' && this.assigneeChanged());
    if (needs && !this.draftReason.trim()) {
      this.reasonNeeded.set(true);
      setTimeout(() => focusById('e-reason'));
      return false;
    }
    return this.saveField();
  }

  pickDuePreset(days: number) {
    const d = endOfDayIn(days, this.tz());
    this.draftDue.set(d);
    this.draftDueInput = toLocalInput(d, this.tz());
  }

  onDueInput(value: string) {
    this.draftDueInput = value;
    this.draftDue.set(parseLocalInput(value, this.tz()));
  }

  /** 1行の欄（タイトル・影響範囲）は Enter で保存（日本語の変換中は除く） */
  onLineKey(e: KeyboardEvent) {
    enterKey(e, () => this.saveField());
  }

  /** 開いている欄を保存する。変わっていなければ、保存せずに閉じる */
  async saveField(): Promise<boolean> {
    const f = this.editField();
    const base = this.editBase();
    if (!f || !base || this.busy()) return false;
    let edits: IssueEdits | null = null;
    if (f === 'title') {
      const v = this.draftText.trim();
      if (!v) return false;
      if (v !== base.title) edits = { title: v };
    } else if (f === 'description') {
      if (this.draftText !== base.description) edits = { description: this.draftText };
    } else if (f === 'doneCriteria') {
      const v = this.draftText.trim();
      if (!v) return false;
      if (v !== base.doneCriteria) edits = { doneCriteria: v };
    } else if (f === 'impact') {
      const v = this.draftText.trim();
      if (v !== (base.impact ?? '')) edits = { impact: v };
    } else if (f === 'occurredOn') {
      const v = this.draftDate || null;
      if (v !== (base.occurredOn ?? null)) edits = { occurredOn: v };
    } else if (f === 'labels') {
      const next = this.draftLabels();
      if ([...next].sort().join() !== [...(base.labelIds ?? [])].sort().join()) edits = { labelIds: next };
    }else if (f === 'assignee') {
      if (this.draftAssignee() !== base.assigneeId) edits = { assigneeId: this.draftAssignee() };
    } else if (f === 'due') {
      const d = this.draftDue();
      if (!d) return false;
      if (d.getTime() !== base.dueAt.toMillis()) edits = { dueAt: d };
    }
    if (!edits) {
      this.closeField();
      return true;
    }
    // 期限と担当者は、理由が必須（経緯と通知に残る）
    const reason = f === 'assignee' || f === 'due' ? this.draftReason.trim() : '';
    if ((f === 'assignee' || f === 'due') && !reason) return false;
    const saved = await this.saveEdits(edits, reason);
    if (saved && this.editField() === f) this.closeField();
    return saved;
  }

  /** 選ぶだけの欄（種別・重要度）：選んだらすぐ保存。今と同じなら何もしない */
  saveNow(edits: IssueEdits) {
    const i = this.issue()!;
    if (edits.type !== undefined && edits.type === i.type) return;
    if (edits.importance !== undefined && edits.importance === i.importance) return;
    this.editBase.set(i);
    this.saveEdits(edits);
  }

  /**
   * 1つの欄を保存する。ほかの人が「別の欄」を変えていただけなら、ぶつかっていないので、
   * 最新を土台に1回だけ保存し直す。「同じ欄」を変えていたら保存せず、知らせて入力を残す
   */
  private async saveEdits(edits: IssueEdits, reason = ''): Promise<boolean> {
    let base = this.editBase() ?? this.issue()!;
    this.busy.set(true);
    this.fieldError.set('');
    this.fieldConflict.set(null);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.issueService.updateIssue(this.pid, base, edits, reason, this.myUid, this.tz());
          return true;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          const latest = e.latest;
          const touched = (Object.keys(edits) as (keyof IssueEdits)[]).some((k) => !sameField(k, base, latest));
          const locked = ['closed', 'merged', 'deleted'].includes(latest.status);
          this.editBase.set(latest);
          if (touched || locked || attempt === 1) {
            this.fieldConflict.set(latest);
            return false;
          }
          base = latest; // ぶつかっていないので、最新を土台にもう一度
        }
      }
      return false;
    } catch (e) {
      console.error(e);
      this.fieldError.set('common.saveError');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /** 回避策のあと「重要度を見直す」：右の重要度へ動かす */
  reviewImportance() {
    focusById('f-importance');
  }

  openMerge() {
    this.base.set(this.issue());
    this.mergeOpen.set(true);
  }

  /** 入力が要らない変更（対応を始める・再開）は、押したらすぐ保存する */
  private async applyNow(t: Transition) {
    this.busy.set(true);
    try {
      await this.issueService.changeStatus(this.pid, this.issue()!, t, EMPTY_STATUS_PAYLOAD, this.myUid, this.tz());
    } catch (e) {
      if (e instanceof ConflictError) {
        // 画面は見張りで最新になっているので、ボタンもすでに最新の状態に合っている
        this.actionConflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async onStatusDone() {
    this.active.set(null);

  }

  async sendComment() {
    const body = this.comment.trim();
    if (!body) return;
    this.busy.set(true);
    try {
      await this.issueService.addComment(this.pid, this.iid, body, this.myUid, this.tz());
      this.comment = '';
    } catch (e) {
      console.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  // ---- 関連課題 ----
  /** 相手の課題を1件ずつ見張る（増えたら始め、外したらやめる）。読めなければ null */
  private syncLinked(rels: IssueRelation[]) {
    const keys = new Set(rels.map((r) => `${r.pid}/${r.iid}`));
    for (const [k, stop] of this.linkStops) {
      if (!keys.has(k)) {
        stop();
        this.linkStops.delete(k);
      }
    }
    for (const r of rels) {
      const k = `${r.pid}/${r.iid}`;
      if (this.linkStops.has(k)) continue;
      this.linkStops.set(k, this.issueService.watchIssue(r.pid, r.iid,
        (issue) => this.linked.update((m) => ({ ...m, [k]: issue })),
        () => this.linked.update((m) => ({ ...m, [k]: null }))));
      if (r.pid !== this.pid) this.loadProjectName(r.pid);
    }
  }

  /** ほかのプロジェクトの名前を読む（メンバーでなければ読めないので、出さない） */
  private async loadProjectName(pid: string) {
    if (this.projectNames()[pid]) return;
    try {
      const p = await this.ps.get(pid);
      if (p) this.projectNames.update((m) => ({ ...m, [pid]: p.name }));
    } catch {
      // 読めないプロジェクト：名前は出さず、課題も「閲覧できない課題」になる
    }
  }

  linkedIssue(r: IssueRelation) {
    return this.linked()[`${r.pid}/${r.iid}`];
  }

  /** 外せるのは、こちらから付けたもの。相手から付けられたものは、同じプロジェクトのときだけ */
  canUnlink(r: IssueRelation) {
    return this.canLink() && (r.dir === 'out' || r.pid === this.pid);
  }

  async unlink(r: IssueRelation) {
    this.busy.set(true);
    this.linkError.set('');
    try {
      await this.issueService.removeLink(this.pid, this.iid, this.issue()!.number, r,
        this.linkedIssue(r)?.number ?? null, this.myUid, this.tz());
    } catch (e) {
      console.error(e);
      this.linkError.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 経緯に出す相手：同じプロジェクトなら番号、ほかのプロジェクトは、今読めるときだけ名前つき */
  private linkTarget(pid: string, number: number | null) {
    if (number === null) return this.i18n.t('links.unreadable');
    if (pid === this.pid) return '#' + number;
    const name = this.projectNames()[pid];
    return name ? `${name} #${number}` : this.i18n.t('links.unreadable');
  }

  memberName(uid: string) {
    const m = this.members().find((x) => x.uid === uid);
    if (m) return m.displayName;
    const former = this.formerMembers[uid];
    return former ? this.i18n.t('project.former', { name: former }) : '—';
  }

  who(latest: Issue) {
    return conflictWho(latest, this.members(), this.myUid);
  }

  eventText(item: TimelineItem) {
    const name = this.memberName(item.by);
    if (item.type === 'link' && item.link) {
      const l = item.link;
      return this.i18n.t('detail.events.link.' + l.action, {
        name, kind: this.i18n.t('links.groups.' + linkGroupOf(l.kind, l.dir)), target: this.linkTarget(l.pid, l.number),
      });
    }
    if (item.type === 'subtask' && item.sub) {
      return this.i18n.t('detail.events.subtask.' + item.sub.action, {
        name, title: item.sub.title, n: String(item.sub.number ?? ''),
      });
    }
    if (item.type === 'created') return this.i18n.t('detail.events.created', { name });
    if (item.type === 'imported') return this.i18n.t('detail.events.imported', { name });
    if (item.type === 'merge' && item.merged) {
      return this.i18n.t('detail.events.merge', { name, n: String(item.merged.number) });
    }
    if (item.type === 'edit') {
      const fields = (item.fields ?? [])
        .map((f) => this.i18n.t('issue.' + (FIELD_LABEL_KEYS[f] ?? f)))
        .join(this.i18n.lang() === 'ja' ? '・' : ', ');
      return this.i18n.t('detail.events.edit', { name, fields });
    }
    if (item.type === 'priority') {
      const label = (p: Level | null | undefined) => p
        ? this.i18n.t('priority.' + p)
        : this.i18n.t('priorityEdit.autoLabel', { p: this.i18n.t('priority.' + item.autoPriority) });
      return this.i18n.t('detail.events.priority', {
        name, from: label(item.fromPriority), to: label(item.toPriority),
      });
    }
    return this.i18n.t('detail.events.status', {
      name,
      from: this.i18n.t('status.' + item.from),
      to: this.i18n.t('status.' + item.to),
    });
  }


  /** 書いた人の現地時間で表示し、見ている人と違えば基準を併記する */
  when(item: TimelineItem) {
    const writerTz = item.tz ?? this.tz();
    const text = formatDateTime(item.at.toDate(), writerTz, this.i18n.lang());
    return writerTz === this.tz() ? text : `${text}（${writerTz}）`;
  }

  fmt(ts: { toDate(): Date }) {
    return formatDateTime(ts.toDate(), this.tz(), this.i18n.lang());
  }

  /** Date をそのまま、見る人のタイムゾーンで表示する（入力中の期限など） */
  fmtDate(d: Date) {
    return formatDateTime(d, this.tz(), this.i18n.lang());
  }

  /** 'YYYY-MM-DD' を「2026年10月13日(火)」のように出す（暦の日付なので、タイムゾーンで変えない） */
  dayLabel(key: string) {
    const [y, m, d] = key.split('-').map(Number);
    return new Intl.DateTimeFormat(this.i18n.lang() === 'ja' ? 'ja-JP' : 'en-US', {
      year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  }

  openPriority(choice: Level | 'auto' | null = null) {
    this.prioBase.set(this.issue());
    this.prioConflict.set(null);
    this.prioChoice.set(choice);
    this.prioReason = '';
    this.error.set('');
    this.prioPanel.set(true);
  }

  async confirmPriority() {
    const choice = this.prioChoice();
    if (!choice) return;
    const value = choice === 'auto' ? null : choice;
    this.busy.set(true);
    this.error.set('');
    this.prioConflict.set(null);
    try {
      await this.issueService.setPriority(
        this.pid, this.prioBase()!, value, this.autoPriority(), this.prioReason.trim(), this.myUid, this.tz(),
      );
      this.prioPanel.set(false);
    } catch (e) {
      if (e instanceof ConflictError) {
        const blocked = e.latest.status === 'closed' || e.latest.status === 'rejected';
        if (!blocked) this.prioBase.set(e.latest);
        this.prioConflict.set({ latest: e.latest, blocked });
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  openCause() {
    const i = this.issue()!;
    this.causeBase.set(i);
    this.causeText = i.cause ?? '';
    this.counterText = i.countermeasure ?? '';
    this.causeCat.set(i.causeCategory ?? null);
    this.causeConflict.set(null);
    this.error.set('');
    this.causePanel.set(true);
  }

  async confirmCause() {
    this.busy.set(true);
    this.error.set('');
    this.causeConflict.set(null);
    try {
      await this.issueService.updateCause(this.pid, this.causeBase()!, {
        cause: this.causeText.trim(), countermeasure: this.counterText.trim(), causeCategory: this.causeCat(),
      }, this.myUid, this.tz());
      this.causePanel.set(false);
    } catch (e) {
      if (e instanceof ConflictError) {
        // 対応中・保留のままなら、最新を土台にもう一度保存できる（入力はそのまま残す）
        const blocked = e.latest.status !== 'in_progress' && e.latest.status !== 'on_hold';
        if (!blocked) this.causeBase.set(e.latest);
        this.causeConflict.set({ latest: e.latest, blocked });
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  openWorkaround() {
    const i = this.issue()!;
    this.waBase.set(i);
    this.waText = i.workaroundEnded ? '' : (i.workaround ?? '');
    this.waConflict.set(null);
    this.waSaved.set(false);
    this.error.set('');
    this.waPanel.set(true);
  }

  async confirmWorkaround() {
    const text = this.waText.trim();
    this.busy.set(true);
    this.error.set('');
    this.waConflict.set(null);
    try {
      await this.issueService.updateWorkaround(this.pid, this.waBase()!, text, this.myUid, this.tz());
      this.waPanel.set(false);
      this.waSaved.set(!!text && this.issue()?.importance !== 'low');
    } catch (e) {
      if (e instanceof ConflictError) {
        const blocked = !this.isActive(e.latest);
        if (!blocked) this.waBase.set(e.latest);
        this.waConflict.set({ latest: e.latest, blocked });
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** 回避策をやめる（箱から）。書き直せば戻せるので、確認はしない */
  async endWorkaround() {
    this.busy.set(true);
    this.waEndError.set('');
    try {
      await this.issueService.endWorkaround(this.pid, this.issue()!, this.myUid, this.tz());
      this.waSaved.set(false);
    } catch (e) {
      if (e instanceof ConflictError) {
        this.waEndError.set('conflict.again'); // 画面は見張りで最新になっている
      } else {
        console.error(e);
        this.waEndError.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** この課題のリンク（URL）をコピーする */
  async copyLink() {
    this.menuOpen.set(false);
    try {
      await navigator.clipboard.writeText(`${location.origin}/p/${this.pid}/i/${this.iid}`);
      this.showFlash('detailMenu.copied');
    } catch {
      this.showFlash('detailMenu.copyFailed');
    }
  }

  private showFlash(key: string) {
    this.flash.set(key);
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.flash.set(''), 3000);
  }

  openDelete() {
    this.delBase.set(this.issue());
    this.delConflict.set(null);
    this.delReason = '';
    this.error.set('');
    this.delPanel.set(true);
  }

  /** 削除したら、リストへ戻って「元に戻す」を出す */
  async confirmDelete() {
    const base = this.delBase()!;
    this.busy.set(true);
    this.error.set('');
    this.delConflict.set(null);
    try {
      await this.issueService.deleteIssue(this.pid, base, this.delReason.trim(), this.myUid, this.tz());
      this.router.navigate(['/p', this.pid, 'list'], { state: { deleted: { iid: this.iid, number: base.number } } });
    } catch (e) {
      if (e instanceof ConflictError) {
        this.delBase.set(e.latest);
        this.delConflict.set(e.latest);
      } else {
        console.error(e);
        this.error.set('common.saveError');
      }
    } finally {
      this.busy.set(false);
    }
  }

  async restore() {
    this.busy.set(true);
    this.error.set('');
    try {
      // 戻ったことは見張りで届くので、ここでは何もしない
      const admins = this.role() === 'admin' ? [] : this.members().filter((m) => m.role === 'admin').map((m) => m.uid);
      await this.issueService.restoreIssue(this.pid, this.iid, this.myUid, this.tz(), admins);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  /** アプリの中で前の画面があればそこへ（見ていた月や絞り込みごと戻る）。なければプロジェクトへ */
  back() {
    const navigationId = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    if (navigationId > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/p', this.pid]);
    }
  }
  // ---- コメントの編集・削除 ----
  startEdit(item: TimelineItem) {
    this.editingId.set(item.id);
    this.editBody = item.body ?? '';
  }

  async saveEdit(item: TimelineItem) {
    const body = this.editBody.trim();
    if (!body) return;
    if (body === item.body) {
      // 何も変えていなければ、保存せずに閉じる（「編集済み」を付けない）
      this.editingId.set(null);
      return;
    }
    this.busy.set(true);
    try {
      await this.issueService.updateComment(this.pid, this.iid, item.id, body);
      this.editingId.set(null);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async askDelete(item: TimelineItem) {
    if (!confirm(this.i18n.t('comment.deleteConfirm'))) return;
    this.busy.set(true);
    try {
      await this.issueService.deleteComment(this.pid, this.iid, item.id, this.myUid);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}