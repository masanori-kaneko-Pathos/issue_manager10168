import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Clock } from '../../core/time/clock';
import { ConflictError, EMPTY_STATUS_PAYLOAD, IssueService, conflictWho } from '../../core/issue/issue.service';
import { ProjectService } from '../../core/project/project.service';
import { Issue, IssueStatus, Level, Member, ProjectWithRole } from '../../core/models';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { Transition, UNDO_OF, availableTransitions } from '../../core/issue/workflow';
import { UndoService } from '../../core/undo/undo.service';
import { shortDue } from '../../core/time/time';
import { PriorityMark } from '../../shared/priority-mark';
import { StatusDialog } from '../../shared/status-dialog';
import { I18nService, TPipe } from '../../i18n/i18n';
import { RecurMark } from '../../shared/recur-mark';

type Mine = Issue & { projectId: string };

/**
 * ホームの「自分の課題」のかんばん。いくつものプロジェクトの課題を、ステータスの列に並べる。
 * 動かしてよいかはプロジェクトごとに違うので、カードごとに「そのプロジェクトでの自分の役割」で決める
 * （プロジェクトのかんばんと同じ availableTransitions）。入力の要る移動は、いつもの窓を開く
 */
@Component({
  selector: 'app-mine-board',
  imports: [TPipe, PriorityMark, RecurMark, CdkDropListGroup, CdkDropList, CdkDrag, StatusDialog],
  template: `
    @if (notMoved(); as m) {
      <p class="notice" role="status">{{ 'conflict.notMoved' | t: { n: '' + m.n } }} {{ m.who.key | t: m.who.params }}</p>
    }
    <div class="board" cdkDropListGroup>
      @for (c of cols; track c) {
        <section class="col" [attr.data-col]="c"
          [class.allowed]="!!dragging() && canDropInto(c)" [class.blocked]="!!dragging() && !canDropInto(c)">
          <header class="col-head">
            <span>{{ 'status.' + c | t }}</span><span class="count">{{ byCol()[c].length }}</span>
          </header>
          <div class="cards" cdkDropList [cdkDropListData]="c" [cdkDropListEnterPredicate]="predicates[c]"
            [cdkDropListSortingDisabled]="true" (cdkDropListDropped)="onDrop($event)">
            @for (i of byCol()[c]; track i.id) {
              <!-- リンクにしない：離した瞬間のクリックで詳細へ飛ばないよう、open() で目印を見てから移る -->
              <article class="card" role="link" tabindex="0" [class.movable]="canDrag(i)"
                [attr.data-p]="active(i) ? prio(i) : null"
                cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canDrag(i)" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                (cdkDragStarted)="onDragStart(i)" (cdkDragEnded)="onDragEnd()"
                (click)="open(i)" (keydown.enter)="open(i)">
                @if (overdue(i)) { <div class="band">{{ 'board.overdue' | t }}</div> }
                <div class="body">
                  <div class="top">
                    @if (active(i)) { <app-priority-mark [level]="prio(i)" [manual]="manual(i)" /> }
                    <span class="num">#{{ i.number }}</span>
                    @if (i.recurringId) { <app-recur-mark /> }
                    <span class="proj">{{ nameOf()(i.projectId) }}</span>
                  </div>
                  <span class="title">{{ i.title }}</span>
                  <span class="due" [class.overdue]="overdue(i)">{{ dueLabel(i) }}</span>
                </div>
              </article>
            } @empty {
              <p class="empty">{{ 'board.empty' | t }}</p>
            }
          </div>
        </section>
      }
    </div>

    @if (pending(); as p) {
      <app-status-dialog [issue]="p.issue" [transition]="p.t" [pid]="p.issue.projectId" [members]="p.members"
        [effort]="effortOf(p.issue.projectId)" (done)="pending.set(null)" (cancel)="pending.set(null)" />
    }
  `,
  styles: `
    .notice { margin: 8px 0 0; padding: 10px 12px; border-radius: 8px; font-size: 13px;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; margin-top: 8px; }
    .col { flex: 1 1 0; min-width: 200px; background: var(--surface-alt); border-radius: 10px;
      border-top: 4px solid var(--disabled); }
    .col[data-col='in_progress'] { border-top-color: var(--primary); }
    .col[data-col='on_hold'] { border-top-color: var(--warning); }
    .col[data-col='resolved'] { border-top-color: var(--success); }
    /* つかんでいる間：落とせる列は点線で囲み、落とせない列は薄くする（プロジェクトのかんばんと同じ） */
    .col.allowed { outline: 2px dashed var(--primary); outline-offset: -2px; }
    .col.blocked { opacity: 0.45; }
    .col-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-weight: bold; font-size: 14px; }
    .count { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface); }
    .cards { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; min-height: 40px; }
    .cards > * { flex: none; }
    .card { display: block; background: var(--surface); border-radius: 8px; border-left: 4px solid var(--disabled);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); overflow: hidden; color: var(--text); cursor: pointer; }
    .card.movable { cursor: grab; }
    .card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); }
    .card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .card[data-p='high'] { border-left-color: var(--danger); }
    .card[data-p='mid'] { border-left-color: var(--warning); }
    .card[data-p='low'] { border-left-color: var(--success); }
    .band { background: var(--danger-bg); color: var(--danger-text); font-size: 11px; font-weight: bold; padding: 2px 10px; }
    .body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .num { font-size: 12px; color: var(--text-muted); }
    .proj { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 11px; color: var(--text-muted); }
    .title { font-size: 14px; overflow-wrap: anywhere; }
    .due { font-size: 12px; color: var(--text-muted); }
    .due.overdue { color: var(--danger); font-weight: bold; }
    .empty { font-size: 12px; color: var(--text-subtle); text-align: center; margin: 8px 0; }
    .cdk-drag-preview { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drag-animating { transition: transform 200ms ease; }
    /* スマホ：1列ずつぴたっと止まる横スクロール。長押しでつかむので、文字の選択やリンクのプレビューを止める */
    @media (max-width: 600px) {
      .board { scroll-snap-type: x mandatory; gap: 8px; }
      .col { flex: 0 0 85%; min-width: 0; scroll-snap-align: center; }
      .card { -webkit-touch-callout: none; user-select: none; }
    }
  `,
})
export class MineBoard {
  /** 自分が担当の課題（ホームが、アーカイブ中・削除フォルダの中を除いて渡す） */
  issues = input.required<Mine[]>();
  /** プロジェクト名の引き方 */
  nameOf = input.required<(pid: string) => string>();
  /** 所属するプロジェクト（役割と設定を見るため。ホームの一覧をそのまま受け取る） */
  projects = input<ProjectWithRole[]>([]);

  private clock = inject(Clock);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);
  private issueService = inject(IssueService);
  private ps = inject(ProjectService);
  private undo = inject(UndoService);
  private router = inject(Router);
  private readonly myUid = auth.currentUser!.uid;
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  /** 自分の課題は「まだ手が要るもの」が中心なので、完了の列は置かない */
  readonly cols: IssueStatus[] = ['open', 'in_progress', 'on_hold', 'resolved'];

  /** つかんでいるカード */
  dragging = signal<Mine | null>(null);
  /** つかんでいる間は、つかんだ時点の並びのままにする（届いた変更は、離したあとに反映） */
  private frozen = signal<Mine[] | null>(null);
  private shown = computed(() => this.frozen() ?? this.issues());
  /** 落としたあと、窓で確かめ中の移動（members は、そのプロジェクトのメンバー） */
  pending = signal<{ issue: Mine; t: Transition; members: Member[] } | null>(null);
  /** 先に更新されていて動かせなかったときの知らせ（数秒で消える） */
  notMoved = signal<{ n: number; who: { key: string; params?: Record<string, string> } } | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 離した直後のクリックで、詳細が開かないようにする目印 */
  private justDragged = false;

  byCol = computed(() => {
    const now = this.clock.now();
    const map = Object.fromEntries(this.cols.map((c) => [c, [] as Mine[]])) as Record<string, Mine[]>;
    for (const i of this.shown()) map[i.status]?.push(i);
    for (const c of this.cols) map[c].sort((a, b) => compareIssues(a, b, now));
    return map;
  });

  private projectOf(pid: string) {
    return this.projects().find((p) => p.id === pid) ?? null;
  }

  /** 工数がオンのプロジェクトか（解決の窓に、実際にかかった時間の欄を出す） */
  effortOf(pid: string) {
    return !!this.projectOf(pid)?.settings?.features?.effort;
  }

  /** この課題で、自分ができる移動（そのプロジェクトでの役割で決める。アーカイブ中は動かせない。却下はかんばんでは扱わない） */
  moves(i: Mine) {
    const p = this.projectOf(i.projectId);
    if (!p || p.archived) return [];
    return availableTransitions(i, p.role, this.myUid).filter((a) => a.allowed && a.t.key !== 'reject');
  }

  canDrag(i: Mine) {
    return this.moves(i).length > 0;
  }

  private canMove(i: Mine, col: IssueStatus) {
    if (i.status === col) return true; // 元の列に戻すのはよい
    return this.moves(i).some((a) => a.t.to === col);
  }

  /** 枠の強調用：今つかんでいるカードを、この列に落とせるか */
  canDropInto(col: IssueStatus) {
    const d = this.dragging();
    return !d || this.canMove(d, col);
  }

  /** CDK に渡す「この列に入れるか」の判定（列ごとに1つ。cols より後に作ること） */
  readonly predicates = Object.fromEntries(
    this.cols.map((c) => [c, (d: CdkDrag<Mine>) => this.canMove(d.data, c)]),
  ) as Record<string, (d: CdkDrag<Mine>) => boolean>;

  onDragStart(i: Mine) {
    this.frozen.set(this.issues());
    this.dragging.set(i);
  }

  onDragEnd() {
    this.dragging.set(null);
    this.frozen.set(null);
    // 離した直後のクリックだけ止める。クリックが届いたあとで目印を戻す
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false));
  }

  onDrop(e: CdkDragDrop<IssueStatus, IssueStatus, Mine>) {
    this.dragging.set(null);
    // 指が列の上にないところで離したら、何もしない（CDK は「最後に入った列」に落としたことにしてしまうため）
    if (e.previousContainer === e.container || !e.isPointerOverContainer) return;
    const a = this.moves(e.item.data).find((m) => m.t.to === e.container.data);
    if (a) this.start(e.item.data, a.t);
  }

  /** 入力が要らない移動はすぐ保存（元に戻すつき）、要るものは窓を開く */
  private async start(issue: Mine, t: Transition) {
    const pid = issue.projectId;
    if (t.needs !== 'none') {
      // 窓は「だれが先に更新したか」の名前にメンバーを使う。そのプロジェクトの分を、開くときに1回だけ読む（赤B）
      const members = await this.ps.listMembers(pid).catch(() => [] as Member[]);
      this.pending.set({ issue, t, members });
      return;
    }
    try {
      await this.issueService.changeStatus(pid, issue, t, EMPTY_STATUS_PAYLOAD, this.myUid, this.tz());
      if (UNDO_OF[t.key]) {
        this.undo.offer('undo.moved', { n: String(issue.number), to: this.i18n.t('status.' + t.to) },
          () => this.issueService.undoStatus(pid, issue, t, this.myUid, this.tz()));
      }
    } catch (e) {
      if (e instanceof ConflictError) {
        const members = await this.ps.listMembers(pid).catch(() => [] as Member[]);
        this.showNotMoved(issue.number, conflictWho(e.latest, members, this.myUid));
      } else {
        console.error(e);
      }
    }
  }

  private showNotMoved(n: number, who: { key: string; params?: Record<string, string> }) {
    this.notMoved.set({ n, who });
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notMoved.set(null), 6000);
  }

  open(i: Mine) {
    if (this.justDragged) return;
    this.router.navigate(['/p', i.projectId, 'i', i.id]);
  }

  active(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  overdue(i: Issue) {
    return this.active(i) && i.dueAt.toMillis() < this.clock.now();
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}