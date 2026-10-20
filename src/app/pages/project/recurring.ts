import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { MAX_RECURRING, RecurringTemplate } from '../../core/models';
import { RecurringService } from '../../core/recurring/recurring.service';
import { auth } from '../../core/firebase';
import { hhmm, nextOccurrence } from '../../core/recurring/schedule';
import { formatDateTime } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { ProjectContext } from './project-context';
import { RecurringDialog } from './recurring-dialog';

/** 定期課題の一覧（プロジェクトの ⋮ から）。だれでも見られる。作る・直す・止める・消すのは管理者だけ */
@Component({
  selector: 'app-recurring',
  imports: [TPipe, RecurringDialog],
  template: `
    <section>
      <div class="head">
        <h2>{{ 'recurring.title' | t }}</h2>
        @if (canManage()) {
          <button type="button" class="primary small" [disabled]="list().length >= max" (click)="editing.set('new')">
            {{ 'recurring.add' | t }}</button>
        }
      </div>
      <p class="help">{{ 'recurring.help' | t }}</p>
      @if (!on()) { <p class="note">{{ 'recurring.off' | t }}</p> }
      @else if (ctx.role() !== 'admin') { <p class="help">{{ 'recurring.adminOnly' | t }}</p> }
      @if (canManage() && list().length >= max) { <p class="help">{{ 'recurring.max' | t: { n: '' + max } }}</p> }

      <ul class="list">
        @for (r of list(); track r.id) {
          <li [class.off]="!r.active">
            <div class="main">
              <strong>{{ r.title }}</strong>
              <span class="sub">{{ describe(r) }}・{{ 'recurring.assignee' | t: { name: nameOf(r.assigneeId) } }}</span>
              @if (r.stopped) {
                <span class="warn">{{ 'recurring.stopped' | t }}</span>
              } @else if (!r.active) {
                <span class="sub">{{ 'recurring.paused' | t }}</span>
              } @else {
                <span class="sub">{{ 'recurring.next' | t: { when: fmt(r) } }}</span>
              }
              @if (r.lastNumber) { <span class="sub">{{ 'recurring.last' | t: { n: '' + r.lastNumber } }}</span> }
            </div>
            @if (canManage()) {
              <div class="acts">
                <button type="button" class="link" (click)="editing.set(r)">{{ 'recurring.edit' | t }}</button>
                @if (r.active) {
                  <button type="button" class="link" [disabled]="busy()" (click)="skip(r)">{{ 'recurring.skip' | t }}</button>
                }
                <button type="button" class="link" [disabled]="busy()" (click)="toggle(r)">
                  {{ (r.active ? 'recurring.pause' : 'recurring.resume') | t }}</button>
                <button type="button" class="link danger" [disabled]="busy()" (click)="remove(r)">
                  {{ 'recurring.delete' | t }}</button>
              </div>
            }
          </li>
        } @empty {
          <li class="empty">{{ 'recurring.empty' | t }}</li>
        }
      </ul>
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
    </section>

    @if (editing(); as e) {
      <app-recurring-dialog [pid]="ctx.pid()" [template]="e === 'new' ? null : e" [members]="assignable()"
        [labels]="ctx.project()?.labels ?? []" (done)="editing.set(null)" (cancel)="editing.set(null)" />
    }
  `,
  styles: `
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 16px; margin: 8px 0; }
    .help { font-size: 12px; color: var(--text-muted); margin: 0 0 8px; }
    .note { padding: 10px 12px; border-radius: 8px; background: var(--surface-alt); font-size: 13px; }
    .list { list-style: none; padding: 0; margin: 8px 0 0; }
    .list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 0;
      border-bottom: 1px solid var(--border); }
    .list li.off .main strong { color: var(--text-muted); }
    .main { flex: 1; min-width: 60%; display: flex; flex-direction: column; gap: 2px; }
    .main strong { overflow-wrap: anywhere; }
    .sub { font-size: 12px; color: var(--text-muted); }
    .warn { font-size: 12px; color: var(--warning-text); background: var(--warning-bg); padding: 4px 8px; border-radius: 6px; }
    .acts { display: flex; gap: 4px; }
    .empty { color: var(--text-muted); }
    .primary { background: var(--primary); color: var(--on-primary); border: none; border-radius: 8px; cursor: pointer; }
    .primary.small { min-height: 40px; padding: 0 16px; font-size: 14px; }
    .primary:disabled { background: var(--disabled); }
    .link { background: none; border: none; color: var(--primary); min-height: 40px; cursor: pointer; font-size: 14px; }
    .link:disabled { color: var(--text-disabled); }
    .danger { color: var(--danger-text); }
    .error { color: var(--danger-text); }
  `,
})
export class Recurring {
  protected ctx = inject(ProjectContext);
  private service = inject(RecurringService);
  private authService = inject(AuthService);
  private i18n = inject(I18nService);

  readonly max = MAX_RECURRING;
  list = signal<RecurringTemplate[]>([]);
  /** 開いている窓（'new'＝作る、雛形＝直す） */
  editing = signal<RecurringTemplate | 'new' | null>(null);
  busy = signal(false);
  error = signal('');

  /** 使う機能でオンか */
  on = computed(() => !!this.ctx.project()?.settings?.features?.recurring);
  /** 作る・直す・止める・消すのは、管理者だけ（オンで、アーカイブ中でないとき） */
  canManage = computed(() => this.ctx.role() === 'admin' && this.on() && !this.ctx.archived());
  /** 担当者にできる人（閲覧者は担当者になれない） */
  assignable = computed(() => this.ctx.members().filter((m) => m.role !== 'viewer'));
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');

  constructor() {
    const stop = this.service.watch(this.ctx.pid(), (l) => this.list.set(l), (e) => {
      console.error(e);
      this.error.set('common.loadError');
    });
    inject(DestroyRef).onDestroy(stop);
  }

  /** 「毎週 月・木 9:00」など。雛形のタイムゾーンが自分と違えば、添える */
  describe(r: RecurringTemplate) {
    const time = hhmm(r.time) + (r.tz !== this.tz() ? `（${r.tz}）` : '');
    if (r.freq === 'daily') return this.i18n.t('recurring.describe.daily', { time });
    if (r.freq === 'weekly') {
      // 月曜はじまりで並べる
      const days = [...r.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map((w) => this.i18n.t('recurring.wd.w' + w)).join(this.i18n.lang() === 'ja' ? '・' : ', ');
      return this.i18n.t('recurring.describe.weekly', { days, time });
    }
    const day = r.monthDay === 31 ? this.i18n.t('recurring.endOfMonth') : this.i18n.t('recurring.dayN', { n: String(r.monthDay) });
    return this.i18n.t('recurring.describe.monthly', { day, time });
  }

  fmt(r: RecurringTemplate) {
    return formatDateTime(r.nextAt.toDate(), this.tz(), this.i18n.lang());
  }

  nameOf(uid: string) {
    const m = this.ctx.members().find((x) => x.uid === uid);
    if (m) return m.displayName;
    const former = this.ctx.project()?.formerMembers?.[uid];
    return former ? this.i18n.t('project.former', { name: former }) : '—';
  }

  async toggle(r: RecurringTemplate) {
    this.busy.set(true);
    this.error.set('');
    try {
        await this.service.setActive(this.ctx.pid(), r, !r.active, auth.currentUser!.uid);
    } catch (e) {
      console.error(e);
      // 動かそうとして断られた＝担当者がもう担当できない（ルールが今の担当者を確かめるため）
      this.error.set(!r.active ? 'recurring.fixAssignee' : 'common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 次の回を飛ばす。戻せない（過ぎた回は作り直さない）ので、どの回かを出して確かめる */
  async skip(r: RecurringTemplate) {
    const next = formatDateTime(new Date(nextOccurrence(r, r.nextAt.toMillis())), this.tz(), this.i18n.lang());
    if (!confirm(this.i18n.t('recurring.skipConfirm', { when: this.fmt(r), next }))) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.service.skipNext(this.ctx.pid(), r);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 削除は元に戻せないので確かめる（作った課題は残る） */
  async remove(r: RecurringTemplate) {
    if (!confirm(this.i18n.t('recurring.deleteConfirm', { title: r.title }))) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.service.remove(this.ctx.pid(), r.id);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}