import { Injectable, inject, signal } from '@angular/core';
import { auth } from '../firebase';
import { InboxMemo, Issue, ProjectWithRole } from '../models';
import { ProjectService } from '../project/project.service';
import { IssueService } from '../issue/issue.service';
import { InboxService } from '../inbox/inbox.service';
import { Hit, hitOf, issueMatches, normalize, rankOf, terms } from './match';

/** 読んだ課題を取っておく時間。開き直すたびに全部読み直さないため */
const KEEP_MS = 5 * 60 * 1000;

/** プロジェクトごとの読んだ課題（issues が null＝まだ読んでいる途中） */
interface Loaded { project: ProjectWithRole; issues: Issue[] | null; error: boolean; }

export interface IssueResult { issue: Issue; rank: number; hit: Hit; }
export interface ProjectResult { project: ProjectWithRole; results: IssueResult[]; loading: boolean; error: boolean; }

/**
 * ヘッダーの検索。所属するプロジェクトの課題を、プロジェクトごとに読んで、画面の中で探す
 * （Firestore には文章の中を探す仕組みがなく、コレクショングループはルールで使えないため）
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private ps = inject(ProjectService);
  private issueService = inject(IssueService);
  private inbox = inject(InboxService);

  private data = signal<Loaded[]>([]);
  loading = signal(false);
  private loadedAt = 0;
  private loadedFor = '';

  /** 読み込む（5分以内に同じ人が読んだものがあれば、それを使う） */
  async load(force = false) {
    const uid = auth.currentUser?.uid;
    if (!uid || this.loading()) return;
    if (!force && uid === this.loadedFor && Date.now() - this.loadedAt < KEEP_MS) return;
    // 別の人でログインし直したときに、前の人の課題を一瞬でも見せない
    if (uid !== this.loadedFor) this.data.set([]);
    this.loading.set(true);
    try {
      const projects = await this.ps.listMyProjects(uid);
      // 先にプロジェクトの枠だけ並べ、読めたものから中身を入れる（遅いプロジェクトを待たせない）
      this.data.set(projects.map((project) => ({ project, issues: null, error: false })));
      await Promise.all(projects.map(async (p) => {
        try {
          const list = (await this.issueService.listAll(p.id)).filter((i) => i.status !== 'deleted');
          this.patch(p.id, { issues: list });
        } catch (e) {
          console.error(e);
          this.patch(p.id, { issues: [], error: true });
        }
      }));
      this.loadedAt = Date.now();
      this.loadedFor = uid;
    } catch (e) {
      console.error(e);
    } finally {
      this.loading.set(false);
    }
  }

  private patch(pid: string, part: Partial<Loaded>) {
    this.data.update((list) => list.map((x) => (x.project.id === pid ? { ...x, ...part } : x)));
  }

  /** 課題を探す。pid を渡すと、そのプロジェクトだけ。当たりのないプロジェクトは外す */
  find(q: string, pid: string | null): ProjectResult[] {
    const ts = terms(q);
    if (!ts.length) return [];
    return this.data()
      .filter((d) => !pid || d.project.id === pid)
      .map((d) => ({
        project: d.project,
        loading: d.issues === null,
        error: d.error,
        results: (d.issues ?? [])
          .filter((i) => issueMatches(i, ts))
          .map((issue) => ({ issue, rank: rankOf(issue, ts), hit: hitOf(issue, ts) }))
          .sort((a, b) => a.rank - b.rank || b.issue.updatedAt.toMillis() - a.issue.updatedAt.toMillis()),
      }))
      .filter((r) => r.loading || r.error || r.results.length);
  }

  /** 受信箱のメモを探す（ゴミ箱は除く。見張っている一覧を使うので、読み込みは増えない） */
  findMemos(q: string): InboxMemo[] {
    const ts = terms(q);
    if (!ts.length) return [];
    return this.inbox.active().filter((m) => {
      const texts = [m.title, m.body].map(normalize);
      return ts.every((t) => texts.some((x) => x.includes(t)));
    });
  }

  
  /** 読んだプロジェクトの名前（検索欄の札に出す。まだ読んでいなければ ''） */
  nameOf(pid: string) {
    return this.data().find((d) => d.project.id === pid)?.project.name ?? '';
  }
}