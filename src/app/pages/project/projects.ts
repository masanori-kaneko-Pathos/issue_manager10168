import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { orderProjects } from '../../core/project/project-order';
import { RequestBadge } from '../../core/request/request-badge.service';
import { ProjectWithRole } from '../../core/models';
import { ProjectNewDialog } from '../../shared/project-new-dialog';
import { DeleteProjectDialog } from './delete-project-dialog';
import { TPipe } from '../../i18n/i18n';

type Group = 'pinned' | 'rest';

/**
 * プロジェクトの一覧（/projects）。引き出しの「すべて見る」から来る。
 * ピン止めの群が上。どちらの群も ⋮⋮ をつかんで並べ替えられる（群はまたげない。ピンはボタンで付け外し）。
 * 並びは users.projectOrder に残し、引き出しも同じ並びになる
 */
@Component({
  selector: 'app-projects-page',
  imports: [RouterLink, TPipe, CdkDropList, CdkDrag, CdkDragHandle, ProjectNewDialog, DeleteProjectDialog],
  host: { '(document:keydown.escape)': 'rowMenu.set(null)' },
  template: `
    <main>
      <div class="head">
        <h1>{{ 'projects.title' | t }}</h1>
        <button type="button" class="primary" (click)="newOpen.set(true)">＋ {{ 'projectNew.title' | t }}</button>
      </div>
      @if (deletedName(); as d) {
        <div class="notice" role="status">
          <p>{{ 'deleteProject.done' | t: { name: d } }}</p>
          <button type="button" class="link" (click)="deletedName.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }

      @if (loading()) {
        <p class="help">{{ 'common.loading' | t }}</p>
      } @else if (!active().length && !archived().length) {
        <p class="empty">{{ 'projects.empty' | t }}</p>
      } @else {
        @if (active().length > 1) { <p class="help">{{ 'projectsPage.help' | t }}</p> }
        <!-- 群ごとに別の落とし先（つながない＝群をまたげない） -->
        @for (g of groups(); track g.key) {
          <ul class="plist" [class.pins]="g.key === 'pinned'" cdkDropList [cdkDropListData]="g.items"
            cdkDropListLockAxis="y" (cdkDropListDropped)="onDrop(g.key, $event)">
            @for (p of g.items; track p.id) {
              @let on = g.key === 'pinned';
              <li cdkDrag [cdkDragData]="p">
                <span class="grip" cdkDragHandle [attr.aria-label]="'projectsPage.drag' | t"
                  [title]="'projectsPage.drag' | t">⋮⋮</span>
                <span class="dot-slot">
                  @if (badge.counts()[p.id]) {
                    <a class="req-dot" [routerLink]="['/p', p.id, 'requests']" [title]="'request.waiting' | t"
                      [attr.aria-label]="'request.waiting' | t"></a>
                  }
                </span>
                <a class="pname" [routerLink]="['/p', p.id]" [title]="p.name">{{ p.name }}</a>
                <span class="role">{{ 'roles.' + p.role | t }}</span>
                <button type="button" class="pin" [class.on]="on" [attr.aria-pressed]="on"
                  [attr.aria-label]="(on ? 'projects.unpin' : 'projects.pin') | t"
                  [title]="(on ? 'projects.unpin' : 'projects.pin') | t" (click)="togglePin(p)">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" [attr.fill]="on ? 'currentColor' : 'none'"
                    stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                    <path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 15v6" /></svg></button>
              </li>
            }
          </ul>
        }

        @if (archived().length) {
          <button type="button" class="link fold-btn" [attr.aria-expanded]="showArchived()"
            (click)="showArchived.set(!showArchived())">
            {{ 'archive.section' | t: { n: '' + archived().length } }}
            <span class="tri" [class.up]="showArchived()" aria-hidden="true">▾</span></button>
          @if (showArchived()) {
            <ul class="plist reveal">
              @for (p of archived(); track p.id) {
                <li class="archived">
                  <a class="pname" [routerLink]="['/p', p.id]" [title]="p.name">{{ p.name }}</a>
                  <span class="role">{{ 'archive.kinds.' + (p.archiveKind ?? 'completed') | t }}</span>
                  @if (p.role === 'admin') {
                    <div class="row-more">
                      <button type="button" class="row-more-btn" [attr.aria-expanded]="rowMenu() === p.id"
                        [attr.aria-label]="'project.menu' | t" [title]="'project.menu' | t"
                        (click)="toggleRowMenu(p.id, $event)">⋮</button>
                      @if (rowMenu() === p.id) {
                        <div class="backdrop" (click)="rowMenu.set(null)"></div>
                        <div class="menu" role="menu" [class.up]="rowMenuUp()" animate.leave="im-out">
                          <button type="button" role="menuitem" [disabled]="busy()" (click)="unarchive(p)">
                            {{ 'archive.unarchive' | t }}</button>
                          <div class="sep" role="separator"></div>
                          <button type="button" role="menuitem" class="danger"
                            (click)="rowMenu.set(null); deleteTarget.set(p)">{{ 'deleteProject.open' | t }}</button>
                        </div>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </main>
    @if (newOpen()) { <app-project-new-dialog (close)="newOpen.set(false)" /> }
    @if (deleteTarget(); as p) {
      <app-delete-project-dialog [pid]="p.id" [name]="p.name" [prefill]="!!p.sample" (done)="onDeleted($event)"
        (cancel)="deleteTarget.set(null)" />
    }
  `,
  styles: `
    main { max-width: 720px; margin: 0 auto; padding: 16px 16px 48px; box-sizing: border-box; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    h1 { margin: 0; font-size: 20px; }
    .help { margin: 0 0 8px; }
    .empty { color: var(--text-muted); font-size: 14px; }
    .notice { background: var(--warning-bg); padding: 12px; border-radius: 8px; margin-bottom: 12px; }
    .notice p { margin: 0 0 8px; }
    .plist { list-style: none; margin: 0; padding: 0; }
    /* ピンの群と、ほかの群の間に線 */
    .plist.pins + .plist { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
    .plist li { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 4px;
      border-bottom: 1px solid var(--border); background: var(--surface); }
    .grip { flex: none; padding: 4px 2px; color: var(--text-subtle); cursor: grab; user-select: none; touch-action: none; }
    .dot-slot { flex: none; width: 20px; display: inline-flex; justify-content: center; }
    /* 対応待ちの依頼：赤い丸（押すと、そのプロジェクトの依頼の一覧へ） */
    .req-dot { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; }
    .req-dot::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--danger); }
    .pname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text); text-decoration: none; font-size: 15px; }
    .pname:hover { text-decoration: underline; }
    .role { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--chip-bg); }
    /* ページでは、ピンをいつも出す（付いていないものは薄く） */
    .pin { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
      padding: 0; border: none; border-radius: 6px; background: none; color: var(--text-subtle); cursor: pointer; }
    .pin:hover { background: var(--surface-alt); color: var(--text); }
    .pin.on { color: var(--primary); }
    .cdk-drag-preview { display: flex; align-items: center; gap: 8px; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
      background: var(--surface); }
    .cdk-drag-placeholder { opacity: 0.3; }
    .cdk-drag-animating { transition: transform 200ms ease; }
    .plist.cdk-drop-list-dragging li:not(.cdk-drag-placeholder) { transition: transform 200ms ease; }
    .fold-btn { gap: 4px; min-height: 40px; margin-top: 12px; font-size: 14px; }
    .tri { display: inline-block; width: 12px; font-size: 11px; text-align: center; transition: rotate 160ms var(--ease-out); }
    .tri.up { rotate: 180deg; }
    .archived .pname { color: var(--text-subtle); }
    .row-more { position: relative; flex: none; }
    .row-more-btn { width: 32px; height: 32px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 16px; cursor: pointer; }
    .row-more-btn:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 220px;
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu button { text-align: left; padding: 0 16px; min-height: 44px; background: none; border: none;
      color: var(--text); font-size: 14px; cursor: pointer; }
    .menu button:hover:not(:disabled) { background: var(--surface-alt); }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .menu button.danger { color: var(--danger-text); font-weight: bold; }
    .menu button.danger:hover { background: var(--danger-bg); }
    .menu.up { top: auto; bottom: calc(100% + 4px); }
  `,
})
export class ProjectsPage implements OnInit {
  private authService = inject(AuthService);
  private ps = inject(ProjectService);
  protected badge = inject(RequestBadge);
  private readonly myUid = auth.currentUser!.uid;
  readonly maxPins = 20;

  projects = signal<ProjectWithRole[]>([]);
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  newOpen = signal(false);
  showArchived = signal(false);
  rowMenu = signal<string | null>(null);
  rowMenuUp = signal(false);
  deleteTarget = signal<ProjectWithRole | null>(null);
  deletedName = signal<string | null>(null);

  /** 保存を待つ間に使う並び（離した瞬間に、元の並びへ跳ね返らないように） */
  private localOrder = signal<string[] | null>(null);
  private pinIds = computed(() => this.authService.profile()?.pinnedProjects ?? []);
  active = computed(() => orderProjects(this.projects(), this.pinIds(),
    this.localOrder() ?? this.authService.profile()?.projectOrder));
  /** ピンの群とほかの群（中身のない群は出さない） */
  groups = computed(() => {
    const pins = new Set(this.pinIds());
    return ([
      { key: 'pinned' as Group, items: this.active().filter((p) => pins.has(p.id)) },
      { key: 'rest' as Group, items: this.active().filter((p) => !pins.has(p.id)) },
    ]).filter((g) => g.items.length);
  });
  archived = computed(() => this.projects().filter((p) => p.archived).sort((a, b) => a.name.localeCompare(b.name)));

  ngOnInit() {
    this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      this.projects.set(await this.ps.listMyProjects(this.myUid));
      this.badge.sync(this.projects()); // 管理者になったばかりのプロジェクトも、印の見張りに入れる
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * 並べ替え：その群の中で動かし、ピンの群＋ほかの群の順で、全部の id を保存する。
   * 群の外（もう一方の群の上など）で離したら、何もしない（元の場所に戻る）
   */
  onDrop(group: Group, e: CdkDragDrop<ProjectWithRole[]>) {
    if (!e.isPointerOverContainer || e.previousIndex === e.currentIndex) return;
    const [pins, rest] = ['pinned', 'rest'].map((k) => [...(this.groups().find((g) => g.key === k)?.items ?? [])]);
    moveItemInArray(group === 'pinned' ? pins : rest, e.previousIndex, e.currentIndex);
    this.saveOrder([...pins, ...rest].map((p) => p.id));
  }

  private async saveOrder(next: string[]) {
    this.localOrder.set(next);
    this.error.set('');
    try {
      await this.authService.updateProfile({ projectOrder: next });
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.localOrder.set(null); // 保存できたらプロフィールに同じ並びが入っている。失敗したら元に戻る
    }
  }

  /** ピンの付け外し（ホームにあったものと同じ。抜けた・消えたプロジェクトの id は、ついでに掃除する） */
  async togglePin(p: ProjectWithRole) {
    const alive = new Set(this.projects().map((x) => x.id));
    const cur = this.pinIds().filter((x) => alive.has(x));
    const next = cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id];
    if (next.length > this.maxPins) {
      this.error.set('projects.pinMax');
      return;
    }
    this.error.set('');
    try {
      await this.authService.updateProfile({ pinnedProjects: next });
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }

  toggleRowMenu(pid: string, e: MouseEvent) {
    if (this.rowMenu() === pid) {
      this.rowMenu.set(null);
      return;
    }
    // ボタンの下に、メニュー（約140px）が収まる空きがあるか
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.rowMenuUp.set(window.innerHeight - r.bottom < 160);
    this.rowMenu.set(pid);
  }

  async unarchive(p: ProjectWithRole) {
    this.rowMenu.set(null);
    this.busy.set(true);
    try {
      await this.ps.unarchive(p.id, this.myUid, p.role);
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async onDeleted(name: string) {
    this.deleteTarget.set(null);
    this.deletedName.set(name);
    await this.load();
  }
}