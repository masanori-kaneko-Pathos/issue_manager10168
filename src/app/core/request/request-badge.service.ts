import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Unsubscribe } from 'firebase/firestore';
import { AuthService } from '../auth/auth.service';
import { ProjectService } from '../project/project.service';
import { ProjectWithRole } from '../models';
import { RequestService } from './request.service';

/**
 * 対応待ちの依頼の数（自分が管理者で、アーカイブ中でないプロジェクトだけ）。
 * ☰ の印・引き出し・プロジェクトのページで同じ数を見るので、root に1つだけ置く
 */
@Injectable({ providedIn: 'root' })
export class RequestBadge {
  private requests = inject(RequestService);
  private ps = inject(ProjectService);
  private authService = inject(AuthService);
  private stops = new Map<string, Unsubscribe>();
  /** プロジェクトごとの、対応待ちの依頼の数 */
  readonly counts = signal<Record<string, number>>({});
  readonly total = computed(() => Object.values(this.counts()).reduce((a, b) => a + b, 0));

  constructor() {
    // ログインしたら見張りを張り、ログアウトしたらやめる（ログインの状態だけを見る。中で読むシグナルは見ない）
    effect(() => {
      const u = this.authService.user();
      untracked(() => {
        if (u) this.refresh(u.uid);
        else this.sync([]);
      });
    });
  }

  /** 所属するプロジェクトを読み直して、見張りを張り直す */
  async refresh(uid: string) {
    try {
      this.sync(await this.ps.listMyProjects(uid));
    } catch (e) {
      console.error(e);
    }
  }

  /** 管理者のプロジェクトに合わせて、見張りを張り直す（増えたら始め、外れたらやめる） */
  sync(projects: ProjectWithRole[]) {
    const pids = new Set(projects.filter((p) => p.role === 'admin' && !p.archived).map((p) => p.id));
    for (const pid of [...this.stops.keys()]) if (!pids.has(pid)) this.stop(pid);
    for (const pid of pids) {
      if (this.stops.has(pid)) continue;
      this.stops.set(pid, this.requests.watchOpen(pid,
        (list) => this.counts.update((m) => ({ ...m, [pid]: list.length })),
        (e) => {
          // 外された・管理者でなくなったプロジェクトは、そこだけやめる
          console.error(e);
          this.stop(pid);
        }));
    }
  }

  private stop(pid: string) {
    this.stops.get(pid)?.();
    this.stops.delete(pid);
    this.counts.update((m) => {
      const { [pid]: _gone, ...rest } = m;
      return rest;
    });
  }
}