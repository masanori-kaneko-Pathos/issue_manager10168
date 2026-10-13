import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { FirestoreError, Unsubscribe } from 'firebase/firestore';
import { Router } from '@angular/router';
import { auth } from '../../core/firebase';
import { Issue, Label, Member, Project, Role } from '../../core/models';
import { ProjectService } from '../../core/project/project.service';
import { IssueService } from '../../core/issue/issue.service';

/** プロジェクト画面の中で共有する情報。入れ物（project-home）ごとに1つ作られる */
@Injectable()
export class ProjectContext {
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private router = inject(Router);
  private stopIssues: Unsubscribe | null = null;
  private stopMembers: Unsubscribe | null = null;

  /** このプロジェクトの未クローズの課題（見張っているので、他の人の変更もすぐ入る） */
  openIssues = signal<Issue[]>([]);
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

  canCreate = computed(() =>
    (this.role() === 'admin' || this.role() === 'member') && !this.project()?.archived);

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
      this.project.set(await this.ps.get(pid));
      // 読み込みの途中で別のプロジェクトに移っていたら、見張りを始めない
      if (this.pid() !== pid) return;
      // メンバーは最初の1回が届くまで待つ（担当者の名前が「—」のまま画面が出ないように）
      await this.watchMembers(pid);
      if (this.pid() === pid && !this.removed()) this.watchIssues(pid);
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
    if (!this.stopIssues && !this.stopMembers) return;
    this.stopIssues?.();
    this.stopMembers?.();
    this.stopIssues = null;
    this.stopMembers = null;
    console.debug('[watch] 課題とメンバーの見張りをやめた'); // 確認用。確かめ終わったら消す
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
  private lostAccess() {
    this.stopWatching();
    this.issuesLoading.set(false);
    this.removed.set(true);
    this.router.navigate(['/'], {
      replaceUrl: true,
      state: { removedFrom: this.project()?.name ?? '' },
    });
  }

  /** 保存したラベルを、ほかのタブにもすぐ反映する（読み直さずに済む） */
  setLabels(labels: Label[]) {
    this.project.update((p) => (p ? { ...p, labels } : p));
  }
}