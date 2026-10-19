import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { FirestoreError, Unsubscribe } from 'firebase/firestore';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { Issue, Label, Member, Project, ProjectSettings, Role } from '../../core/models';
import { ProjectService } from '../../core/project/project.service';
import { IssueService } from '../../core/issue/issue.service';
import { RequestService } from '../../core/request/request.service';
import { IssueRequest } from '../../core/models';
import { I18nService } from '../../i18n/i18n';

/** プロジェクト画面の中で共有する情報。入れ物（project-home）ごとに1つ作られる */
@Injectable()
export class ProjectContext {
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private requests = inject(RequestService);
  private stopRequests: Unsubscribe | null = null;
  /** このプロジェクトの、対応待ちの依頼（⋮ の件数と、依頼の一覧のページで使う） */
  openRequests = signal<IssueRequest[]>([]);
  /** 自分が見る依頼：管理者は全員の、それ以外は自分が出したものだけ */
  myRequests = computed(() => this.role() === 'admin'
    ? this.openRequests()
    : this.openRequests().filter((r) => r.by === auth.currentUser!.uid));
  private router = inject(Router);
  private i18n = inject(I18nService);
  /** 自分から抜けている最中（見張りが「外された」と勘違いしないための印） */
  private leaving = false;
  /** 自分でプロジェクトを削除している最中（移動は削除のダイアログがする） */
  private deleting = false;
  private stopIssues: Unsubscribe | null = null;
  private stopMembers: Unsubscribe | null = null;
  private stopProject: Unsubscribe | null = null;

  /** このプロジェクトの未クローズの課題（見張っているので、他の人の変更もすぐ入る） */
  openIssues = signal<Issue[]>([]);
  /** リストのタブが今見せている一覧（絞り込み・検索・並び順のまま）。リスト以外のタブにいるときは null */
  listView = signal<Issue[] | null>(null);
  issuesLoading = signal(true);

  constructor() {
    // プロジェクトの画面（project-home）を離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => this.stopWatching());
  }
  pid = signal('');
  project = signal<Project | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  loading = signal(true);
  notFound = signal(false);
  /** メンバーから外された（読み込み途中の load() が、課題の見張りを始めないための目印） */
  removed = signal(false);

  /** アーカイブ中か（閲覧専用。各タブはここを見て、押せる所を出さない） */
  archived = computed(() => !!this.project()?.archived);

  canCreate = computed(() =>
    (this.role() === 'admin' || this.role() === 'member') && !this.project()?.archived);

  /** 担当者になれる人（管理者とメンバー）。人の絞り込みの一覧に使う */
  assignable = computed(() => this.members().filter((m) => m.role !== 'viewer'));

  /**
   * 人ごとの未完了（未着手・対応中・保留）の件数。人の絞り込みで、名前の横に薄く出す。
   * 解決済みは提起者の確認待ちで、担当者の手を離れているので数えない（メンバーのタブは引き継ぎの数なので、解決済みも数える）
   */
  activeCount = computed(() => {
    const map: Record<string, number> = {};
    for (const i of this.openIssues()) {
      if (i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold') {
        map[i.assigneeId] = (map[i.assigneeId] ?? 0) + 1;
      }
    }
    return map;
  });

  async load(pid: string) {
    // 別のプロジェクトに移ったときは、前の見張りをやめてから始める
    this.stopWatching();
    this.openIssues.set([]);
    this.members.set([]);
    this.issuesLoading.set(true);
    this.pid.set(pid);
    this.loading.set(true);
    this.notFound.set(false);
    this.removed.set(false);
    try {
      // メンバーでなければ、ここでルールに止められて例外になる
      const role = await this.ps.myRole(pid, auth.currentUser!.uid);
      if (!role) throw new Error('not a member');
      this.role.set(role);
      // プロジェクトも見張る（ほかの管理者が設定やラベルを変えても、すぐ届く）。最初の1回が届くまで待つ
      await this.watchProject(pid);
      // 読み込みの途中で別のプロジェクトに移っていたら、見張りを始めない
      if (this.pid() !== pid) return;
      // メンバーは最初の1回が届くまで待つ（担当者の名前が「—」のまま画面が出ないように）
      await this.watchMembers(pid);
      if (this.pid() === pid && !this.removed()) {
        this.watchIssues(pid);
        this.stopRequests = this.requests.watchOpen(pid, (list) => this.openRequests.set(list),
          (e) => this.onWatchError(e));
      }
    } catch (e) {
      console.error(e);
      this.notFound.set(true);
    } finally {
      // 別のプロジェクトの読み込みが進んでいるときは、その「読み込み中」を消さない
      if (this.pid() === pid) this.loading.set(false);
    }
  }
  private watchIssues(pid: string) {
    this.stopIssues = this.issueService.watchOpen(
      pid,
      (issues) => {
        this.openIssues.set(issues);
        this.issuesLoading.set(false);
      },
      (e) => {
        this.issuesLoading.set(false);
        this.onWatchError(e);
      },
    );
  }

  private stopWatching() {
    this.stopIssues?.();
    this.stopMembers?.();
    this.stopProject?.();
    this.stopRequests?.();
    this.stopIssues = null;
    this.stopMembers = null;
    this.stopProject = null;
    this.stopRequests = null;
    this.openRequests.set([]);
  }

  /** プロジェクトを見張る。最初の1回が届いたら、待っている load() に知らせる */
  private watchProject(pid: string) {
    return new Promise<void>((resolve, reject) => {
      this.stopProject = this.ps.watchProject(
        pid,
        (project) => {
          // ほかの管理者がプロジェクトを削除し始めた（または、もう無い）
          if (project?.deleting || (!project && this.project())) {
            this.lostAccess(true);
            return;
          }
          this.project.set(project);
          resolve(); // 2回目以降に呼ばれても何も起きない
        },
        (e) => {
          this.onWatchError(e);
          reject(e);
        },
      );
    });
  }
    /** メンバーを見張る。最初の1回が届いたら、待っている load() に知らせる */
    private watchMembers(pid: string) {
      return new Promise<void>((resolve, reject) => {
        this.stopMembers = this.ps.watchMembers(
          pid,
          (members) => {
            this.applyMembers(members);
            resolve(); // 2回目以降に呼ばれても何も起きない
          },
          (e) => {
            this.onWatchError(e);
            reject(e);
          },
        );
      });
    }
  
    /** 自分の役割も、メンバー一覧から取り直す（役割の変更がすぐ効く） */
    private applyMembers(members: Member[]) {
      const me = members.find((m) => m.uid === auth.currentUser!.uid);
      if (!me) {
        this.lostAccess();
        return;
      }
      this.members.set(members);
      this.role.set(me.role);
    }
  
    /** 見張りのエラー。一度入れたあとに読めなくなった＝メンバーから外された */
    private onWatchError(e: FirestoreError) {
      console.error(e);
      if (e.code === 'permission-denied') this.lostAccess();
    }
  
  /** 外されたら、ホームへ戻して知らせる（「戻る」で見られない画面に戻らないよう、履歴を置き換える） */
  private lostAccess(gone = false) {
    // 見張りが3本（プロジェクト・メンバー・課題）あるので、外されたときは知らせが3回来うる。2回目からは何もしない
    if (this.removed()) return;
    this.stopWatching();
    this.issuesLoading.set(false);
    this.removed.set(true);
    if (this.deleting) return; // 自分で削除している：移動は削除のダイアログがする
    const name = this.project()?.name ?? '';
    this.router.navigate(['/'], {
      replaceUrl: true,
      // 削除された・自分から抜けた・外された、で、ホームの知らせを変える
      state: gone ? { deletedProject: name } : this.leaving ? { leftFrom: name } : { removedFrom: name },
    });
  }

  markLeaving(v: boolean) {
    this.leaving = v;
  }

  markDeleting(v: boolean) {
    this.deleting = v;
  }

  /** 名前を引く。外れた人は formerMembers から「（退出）」つきで出す */
  nameOf(uid: string) {
    const m = this.members().find((x) => x.uid === uid);
    if (m) return m.displayName;
    const former = this.project()?.formerMembers?.[uid];
    return former ? this.i18n.t('project.former', { name: former }) : '—';
  }

  /** 外した人の名前を、手元のプロジェクトにもすぐ反映する（読み直さずに済む） */
  addFormer(uid: string, name: string) {
    this.project.update((p) => (p ? { ...p, formerMembers: { ...(p.formerMembers ?? {}), [uid]: name } } : p));
  }

  /** 保存したラベルを、ほかのタブにもすぐ反映する（読み直さずに済む） */
  setLabels(labels: Label[]) {
    this.project.update((p) => (p ? { ...p, labels } : p));
  }

  
  /** 保存した設定を、ほかのタブにもすぐ反映する（停滞の日数など） */
  setSettings(settings: ProjectSettings) {
    this.project.update((p) => (p ? { ...p, settings } : p));
  }
}