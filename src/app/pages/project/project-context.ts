import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Unsubscribe } from 'firebase/firestore';
import { auth } from '../../core/firebase';
import { Issue, Label, Member, Project, Role } from '../../core/models';
import { ProjectService } from '../../core/project/project.service';
import { IssueService } from '../../core/issue/issue.service';

/** プロジェクト画面の中で共有する情報。入れ物（project-home）ごとに1つ作られる */
@Injectable()
export class ProjectContext {
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private stopIssues: Unsubscribe | null = null;

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

  canCreate = computed(() =>
    (this.role() === 'admin' || this.role() === 'member') && !this.project()?.archived);

  async load(pid: string) {
    // 別のプロジェクトに移ったときは、前の見張りをやめてから始める
    this.stopWatching();
    this.openIssues.set([]);
    this.issuesLoading.set(true);
    this.pid.set(pid);
    this.loading.set(true);
    this.notFound.set(false);
    try {
      // メンバーでなければ、ここでルールに止められて例外になる
      const role = await this.ps.myRole(pid, auth.currentUser!.uid);
      if (!role) throw new Error('not a member');
      this.role.set(role);
      this.project.set(await this.ps.get(pid));
      this.members.set(await this.ps.listMembers(pid));
      // 読み込みの途中で別のプロジェクトに移っていたら、見張りを始めない
      if (this.pid() === pid) this.watchIssues(pid);
    } catch (e) {
      console.error(e);
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
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
        console.error(e);
        this.issuesLoading.set(false);
        // 見ている途中でプロジェクトから外された場合
        if (e.code === 'permission-denied') this.notFound.set(true);
      },
    );
  }

  private stopWatching() {
    if (!this.stopIssues) return;
    this.stopIssues();
    this.stopIssues = null;
    console.debug('[watch] 課題の見張りをやめた'); // 確認用。確かめ終わったら消す
  }
  /** 保存したラベルを、ほかのタブにもすぐ反映する（読み直さずに済む） */
  setLabels(labels: Label[]) {
    this.project.update((p) => (p ? { ...p, labels } : p));
  }
}