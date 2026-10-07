import { Injectable, computed, inject, signal } from '@angular/core';
import { auth } from './firebase';
import { Label, Member, Project, Role } from './models';
import { ProjectService } from './project.service';

/** プロジェクト画面の中で共有する情報。入れ物（project-home）ごとに1つ作られる */
@Injectable()
export class ProjectContext {
  private ps = inject(ProjectService);

  pid = signal('');
  project = signal<Project | null>(null);
  role = signal<Role | null>(null);
  members = signal<Member[]>([]);
  loading = signal(true);
  notFound = signal(false);

  canCreate = computed(() =>
    (this.role() === 'admin' || this.role() === 'member') && !this.project()?.archived);

  async load(pid: string) {
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
    } catch (e) {
      console.error(e);
      this.notFound.set(true);
    } finally {
      this.loading.set(false);
    }
  }
    /** 保存したラベルを、ほかのタブにもすぐ反映する（読み直さずに済む） */
    setLabels(labels: Label[]) {
        this.project.update((p) => (p ? { ...p, labels } : p));
      }
}