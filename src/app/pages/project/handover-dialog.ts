import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { Member, RecurringTemplate, Role } from '../../core/models';
import { MemberChange, ProjectService } from '../../core/project/project.service';
import { RecurringService } from '../../core/recurring/recurring.service';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';

/** handover＝担当の引き継ぎだけ、self＝自分の担当を渡す（抜けずに）、remove＝外す、role＝閲覧者に変える、leave＝自分から抜ける */
export type HandoverMode = 'handover' | 'self' | 'remove' | 'role' | 'leave';

/** 「渡さない（今のまま）」のペン。uid と重ならない文字にする */
const KEEP = '-';
/** 塗った結果の、定期課題の雛形の行の名札（課題の id と混ざらないように頭に付ける） */
const R = 'r:';
/** この人数から、ペンの札を名前で絞る欄を出す（人の絞り込みの吹き出しと同じ） */
const FILTER_FROM = 7;

/**
 * 担当の引き継ぎ（外す・閲覧者に変える・抜けるときにも、先に引き継ぐ）。
 * 「ペン方式」：上の札で渡す人（ペン）を選び、課題の行を押すと、その人に塗る。
 * マウスなら、押したままなぞると続けて塗れる。理由は全部で1回。
 * 定期課題の雛形は、最初は「変えない」（その回だけ渡すのが初期値）。次の回からも渡すときだけ塗る
 */
@Component({
  selector: 'app-handover-dialog',
  imports: [FormsModule, TPipe],
  host: {
    '(document:keydown.escape)': 'cancel.emit()',
    // どこでボタンを離しても、ペンを紙から上げる（行の外で離したときも）
    '(document:pointerup)': 'painting = false',
    '[animate.leave]': "'im-out-dialog'",
  },
  template: `
    <div class="backdrop" (click)="cancel.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="cancel.emit()">✕</button>
      <h2>{{ 'handover.title.' + mode() | t: { name: target().displayName, role: i18n.t('roles.' + (role() ?? 'viewer')) } }}</h2>
      <p class="help">{{ 'handover.note.' + mode() | t }}</p>
      @if (subtaskIssues(); as n) {
        <p class="help">{{ (onlyHandover() ? 'handover.subtasksFollow' : 'handover.subtasksMove') | t: { n: '' + n } }}</p>
      }
      @if (myRecurCount(); as n) { <p class="help">{{ 'handover.recurAskAdmin' | t: { n: '' + n } }}</p> }

      @if (issues().length || templates().length) {
        <div class="pens-head">
          <span class="label">{{ 'handover.to' | t }}</span>
          @if (successors().length >= FILTER_FROM) {
            <input type="search" class="pen-filter" [ngModel]="q()" (ngModelChange)="q.set($event)"
              [placeholder]="'handover.penFilter' | t" [attr.aria-label]="'handover.penFilter' | t" />
          }
        </div>
        <div class="pens" role="radiogroup" [attr.aria-label]="'handover.to' | t">
          @for (m of pens(); track m.uid) {
            <button type="button" role="radio" class="pen" [class.on]="pen() === m.uid" [attr.aria-checked]="pen() === m.uid"
              (click)="pen.set(m.uid)">
              {{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</button>
          }
        </div>
        <p class="help">{{ 'handover.penHelp' | t }}</p>

        @if (issues().length) {
          @if (pen(); as p) {
            <button type="button" class="link fill" (click)="fillAll()">
              {{ 'handover.fillAll' | t: { name: penName(p) } }}</button>
          }
          <p class="label">{{ 'handover.issues' | t: { n: '' + issues().length } }}</p>
          <ul class="issues" [class.armed]="!!pen()">
            @for (i of issues(); track i.id) {
              @let d = destOf(i.id);
              <li (pointerdown)="down(i.id, $event)" (pointerenter)="enter(i.id)">
                <button type="button" class="issue-row" [class.keep]="d === KEEP" [disabled]="!pen()"
                  [attr.aria-label]="'handover.paintRow' | t: { n: '' + i.number }" (click)="paint(i.id)">
                  <span class="it"><span class="num">#{{ i.number }}</span> {{ i.title }}
                    <span class="st">{{ 'status.' + i.status | t }}</span></span>
                  <span class="dest" [class.none]="!d">{{ d ? penName(d) : ('handover.undecided' | t) }}</span>
                </button>
              </li>
            }
          </ul>
          @if (summary()) { <p class="summary">{{ summary() }}</p> }
        }

        @if (templates().length) {
          <label class="field">{{ 'handover.recurTo' | t: { n: '' + templates().length } }}
            <select [ngModel]="recurDest()" (ngModelChange)="recurTo.set($event)">
              @for (m of sortedSuccessors(); track m.uid) {
                <option [value]="m.uid">{{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</option>
              }
            </select>
          </label>
          <p class="help">{{ 'handover.recurToHelp' | t }}</p>
        }

        <label class="field">{{ 'handover.reason' | t }}
          <textarea [(ngModel)]="reason" rows="2" maxlength="1000" [placeholder]="'handover.reasonHint' | t"></textarea>
        </label>
      } @else {
        <p class="none">{{ 'handover.none' | t }}</p>
      }

      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
      <div class="row">
        <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
        <button type="button" class="primary" [class.danger]="mode() === 'remove' || mode() === 'leave'"
          [disabled]="busy() || !ready()" (click)="confirm()">{{ 'handover.confirm.' + mode() | t }}</button>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    h2 { overflow-wrap: anywhere; }
    .help.warn { padding: 0; border: none; background: none; }
    .label { margin: 0; font-size: 14px; font-weight: bold; }
    .pens-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .pen-filter { min-height: 36px; font-size: 14px; width: 180px; }
    .pens { display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow: auto; }
    .pen { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 18px;
      background: var(--surface); color: var(--text); font-size: 14px; cursor: pointer; }
    .pen.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .pen.keep:not(.on) { color: var(--text-muted); border-style: dashed; }
    .fill { align-self: flex-start; min-height: 32px; font-size: 13px; }
    .issues { list-style: none; margin: 0; padding: 0; max-height: 300px; overflow: auto;
      background: var(--surface-alt); border-radius: 8px; font-size: 13px;
      /* なぞって塗るとき、文字の選択が始まらないように */
      user-select: none; -webkit-user-select: none; }
    .issues li + li { border-top: 1px solid var(--border); }
    .issue-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; width: 100%; padding: 8px 12px;
      border: none; background: none; text-align: left; font: inherit; color: var(--text); }
    .issues.armed .issue-row { cursor: pointer; }
    .issues.armed .issue-row:hover { background: var(--surface-muted); }
    .issue-row:disabled { color: var(--text); cursor: default; }
    .issue-row.keep .it { color: var(--text-muted); }
    .it { flex: 1; min-width: 50%; overflow-wrap: anywhere; }
    .recur { vertical-align: -2px; color: var(--text-muted); }
    .num { color: var(--text-muted); }
    .st { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--surface-muted); }
    .dest { flex: none; font-weight: bold; color: var(--primary); }
    .dest.none { font-weight: normal; color: var(--text-subtle); }
    .issue-row.keep .dest { color: var(--text-muted); }
    .summary { margin: 0; font-size: 13px; color: var(--text-secondary); }
    textarea { font-weight: normal; }
    .none { margin: 0; font-size: 14px; }
  `,
})
export class HandoverDialog {
  mode = input.required<HandoverMode>();
  target = input.required<Member>();
  /** mode が role のときの、変えた先の役割 */
  role = input<Role | null>(null);
  done = output<void>();
  cancel = output<void>();

  private ctx = inject(ProjectContext);
  private ps = inject(ProjectService);
  private authService = inject(AuthService);
  private recurService = inject(RecurringService);
  protected i18n = inject(I18nService);
  readonly KEEP = KEEP;
  readonly R = R;
  readonly FILTER_FROM = FILTER_FROM;
  readonly myUid = auth.currentUser!.uid;
  /** 担当を渡すだけか（だれかを外したり、役割を変えたりしない）。self も同じ動き */
  onlyHandover = computed(() => this.mode() === 'handover' || this.mode() === 'self');

  /** 今持っているペン（渡す人の uid か KEEP。まだ選んでいなければ null） */
  pen = signal<string | null>(null);
  /** 塗った結果（課題id、または「r:雛形id」→ uid か KEEP） */
  private dest = signal<Record<string, string>>({});
  /** マウスのボタンを押したまま、なぞっている最中か */
  painting = false;
  q = signal('');
  reason = '';
  busy = signal(false);
  error = signal('');
  /** このプロジェクトの定期課題の雛形 */
  private allRecur = signal<RecurringTemplate[]>([]);

  constructor() {
    const stop = this.recurService.watch(this.ctx.pid(), (l) => this.allRecur.set(l), (e) => console.error(e));
    inject(DestroyRef).onDestroy(stop);
  }

  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  /** 引き継ぐ課題：その人が担当している未完了の課題（置き場の見張りから読むので、読み直しは要らない） */
  issues = computed(() => this.ctx.openIssues()
    .filter((i) => i.assigneeId === this.target().uid)
    .sort((a, b) => a.number - b.number));

  /** その人が担当している、未完了のサブタスクがある課題の数（窓に一言出すため） */
  subtaskIssues = computed(() => this.ctx.openIssues()
    .filter((i) => (i.subtaskAssignees ?? []).includes(this.target().uid)).length);

  /**
   * 雛形も一緒に直せるか（ルールと同じ：管理者の操作で、使う機能がオン・アーカイブ中でない）。
   * 自分から抜けるときは、管理者ではないので直せない（次の回で関数が止めて、管理者に知らせる）
   */
  private canRecur = computed(() => this.mode() !== 'leave' && this.ctx.role() === 'admin' && !this.ctx.archived()
    && !!this.ctx.project()?.settings?.features?.recurring);
  /** その人が担当の、定期課題の雛形 */
  templates = computed(() => this.canRecur()
    ? this.allRecur().filter((r) => r.assigneeId === this.target().uid) : []);
  /**
   * 管理者でない人が、自分の担当を渡す・自分から抜けるとき：自分が担当の定期課題の数（窓では直せないので、一言だけ出す）。
   * 雛形を書けるのは管理者だけ（ルール）なので、窓には行を出さない
   */
  myRecurCount = computed(() => {
    if (this.canRecur() || !(this.mode() === 'self' || this.mode() === 'leave')) return 0;
    if (!this.ctx.project()?.settings?.features?.recurring) return 0;
    return this.allRecur().filter((r) => r.assigneeId === this.target().uid).length;
  });
  /** 引き継げる人：本人以外の、管理者とメンバー（閲覧者は担当者になれない） */
  successors = computed(() => this.ctx.members().filter((m) => m.uid !== this.target().uid && m.role !== 'viewer'));
  /** ペンの札：自分が先頭、あとは名前順。人が多いときは名前で絞る（選んでいるペンは、絞っても残す） */
  pens = computed(() => {
    const q = this.q().trim().toLowerCase();
    return [...this.successors()]
      .filter((m) => !q || m.uid === this.pen() || m.displayName.toLowerCase().includes(q))
      .sort((a, b) => Number(b.uid === this.myUid) - Number(a.uid === this.myUid)
        || a.displayName.localeCompare(b.displayName));
  });

  /** 引き継げる人の並び（自分が先頭、あとは名前順。定期課題の欄で使う） */
  sortedSuccessors = computed(() => [...this.successors()]
    .sort((a, b) => Number(b.uid === this.myUid) - Number(a.uid === this.myUid)
      || a.displayName.localeCompare(b.displayName)));
  /** 定期課題の次の回からの担当（選んだ人。選んでいなければ null） */
  recurTo = signal<string | null>(null);
  /** 実際の渡し先：選んだ人 → 課題を一番多く受け取る人 → 自分 → 先頭 */
  recurDest = computed(() => {
    const ok = new Set(this.successors().map((m) => m.uid));
    const picked = this.recurTo();
    if (picked && ok.has(picked)) return picked;
    const count = new Map<string, number>();
    for (const [k, p] of Object.entries(this.dest())) {
      if (!k.startsWith(R) && p !== KEEP) count.set(p, (count.get(p) ?? 0) + 1);
    }
    const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    return top ?? (ok.has(this.myUid) ? this.myUid : this.sortedSuccessors()[0]?.uid ?? null);
  });  

  /** 行き先。担当の引き継ぎだけのときは、塗っていない行は「渡さない」（外す・閲覧者にするときは「まだ決めていない」） */
  destOf(id: string): string | null {
    return this.dest()[id] ?? (this.onlyHandover() ? KEEP : null);
  }

  penName(p: string) {
    if (p === KEEP) return this.i18n.t('handover.keep');
    return this.successors().find((m) => m.uid === p)?.displayName ?? '—';
  }

  /** 「Aさん 3件・Bさん 2件」のまとめ（課題だけ。押す前に、だれへ何件行くかを確かめられるように） */
  summary = computed(() => {
    const count = new Map<string, number>();
    for (const i of this.issues()) {
      const d = this.destOf(i.id);
      if (d) count.set(d, (count.get(d) ?? 0) + 1);
    }
    return [...count].map(([d, n]) => d === KEEP
      ? this.i18n.t('handover.keepN', { n: String(n) })
      : this.i18n.t('handover.split', { name: this.penName(d), n: String(n) }))
      .join(this.i18n.lang() === 'ja' ? '・' : ', ');
  });

  /** マウスで押して塗った行。直後のクリックで二度塗り（戻す）にならないように、1回だけ見送る */
  private strokeId: string | null = null;
  /** なぞりの向き：true なら消す（最初に押した行が、もう同じペンで塗ってあったとき） */
  private erasing = false;

  /** 塗る・消すの本体（なぞりからも、1回押しからも呼ぶ）。消すと塗っていない状態に戻る（destOf が読み替える） */
  private stroke(id: string) {
    const p = this.pen();
    if (!p) return;
    const now = this.dest()[id];
    if (this.erasing) {
      if (now === p) this.dest.update((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
      return;
    }
    if (now !== p) this.dest.update((m) => ({ ...m, [id]: p }));
  }

  /**
   * 1行を押した（指・キーボード・マウスのクリック）。
   * もう同じ人で塗ってあれば、塗る前に戻す。マウスで押した直後のクリックは、down で済んでいるので見送る
   */
  paint(id: string) {
    if (this.strokeId === id) {
      this.strokeId = null;
      return;
    }
    this.strokeId = null;
    if (!this.pen()) return;
    this.erasing = this.dest()[id] === this.pen();
    this.stroke(id);
    this.erasing = false;
  }

  /** 課題を全部、今のペンで塗る（雛形は塗らない：次の回からも渡すかは、1つずつ決めてもらう） */
  fillAll() {
    const p = this.pen();
    if (!p) return;
    this.dest.update((m) => ({ ...m, ...Object.fromEntries(this.issues().map((i) => [i.id, p])) }));
  }

  /**
   * マウスで押した：その行を塗って、なぞり塗りを始める。
   * 指は除く（一覧をスクロールしようとしただけで塗られてしまうため。指は「押す」で1件ずつ）
   */
  down(id: string, e: PointerEvent) {
    const p = this.pen();
    if (e.pointerType !== 'mouse' || e.button !== 0 || !p) return;
    this.painting = true;
    // 最初の行で向きを決める（塗ってある行から始めたら、なぞった先も消す）
    this.erasing = this.dest()[id] === p;
    this.stroke(id);
    this.strokeId = id;
  }

  /** なぞっている最中に、別の行に入った */
  enter(id: string) {
    if (this.painting) this.stroke(id);
  }

  /** 実際に渡す課題（課題id → 人）。雛形・渡さない・まだ決めていないものは入れない */
  private dests(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.dest()).filter(([k, p]) => !k.startsWith(R) && p !== KEEP));
  }

  /** 雛形の直し（雛形id → 次の回からの担当・作った人） */
  private recurUpdates(): Record<string, { assigneeId?: string; createdBy?: string }> {
    const out: Record<string, { assigneeId?: string; createdBy?: string }> = {};
    if (!this.canRecur()) return out;
    // 担当者ごと替える（雛形を1つずつ選ばない。替えないと、次の回で止まるため）
    const to = this.recurDest();
    if (to) for (const r of this.templates()) out[r.id] = { assigneeId: to };
    // 外す・閲覧者にする人が作った雛形は、今の管理者が引き取る（作った人が担当できなくなると、次の回で止まるため）
    if (!this.onlyHandover()) {
      for (const r of this.allRecur()) {
        if (r.createdBy === this.target().uid) out[r.id] = { ...out[r.id], createdBy: this.myUid };
      }
    }
    return out;
  }

  /** 雛形の担当を、実際に替えるものがあるか */
  private recurMoves() {
    return this.recurDest() ? this.templates().length : 0;
  }

  /**
   * 課題は、全部の行の行き先が必須。何かを渡すなら、理由も必須。
   * 「担当を引き継ぐ」だけのときは、1つも渡さないなら押せない（何も起きないため）
   */
  ready() {
    if (this.issues().some((i) => !this.destOf(i.id))) return false;
    const moving = Object.keys(this.dests()).length + this.recurMoves();
    if (this.onlyHandover() && !moving) return false;
    return !moving || !!this.reason.trim();
  }

  async confirm() {
    const mode = this.mode();
    const change: MemberChange =
      mode === 'role' ? { kind: 'role', role: this.role()! }
      : mode === 'remove' ? { kind: 'remove' }
      : mode === 'leave' ? { kind: 'leave' }
      : null;
    this.busy.set(true);
    this.error.set('');
    // 自分から抜けるときは、見張りが「外された」と勘違いしないように、先に印を付ける
    if (mode === 'leave') this.ctx.markLeaving(true);
    try {
      await this.ps.changeMember(
        this.ctx.pid(), this.target(), this.dests(), this.reason.trim(), change, auth.currentUser!.uid, this.tz(),
        this.recurUpdates(),
      );
      if (mode === 'remove') this.ctx.addFormer(this.target().uid, this.target().displayName);
      this.done.emit();
    } catch (e) {
      console.error(e);
      if (mode === 'leave') this.ctx.markLeaving(false);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}