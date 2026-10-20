import { Injectable, inject } from '@angular/core';
import { auth } from '../firebase';
import { AuthService } from '../auth/auth.service';
import { ProjectService } from './project.service';
import { EMPTY_STATUS_PAYLOAD, IssueService } from '../issue/issue.service';
import { TRANSITIONS } from '../issue/workflow';
import { SearchService } from '../search/search.service';
import { endOfDayIn } from '../time/time';
import { I18nService } from '../../i18n/i18n';

/**
 * 見本のプロジェクトを作る（イントロダクション）。中身：課題2つ・サブタスク3つ・コメント1つ。
 * 言葉は、作る瞬間の言語で入れる（あとで言語を変えても、中身はそのまま。入力された文章は翻訳しない決まりと同じ）
 */
@Injectable({ providedIn: 'root' })
export class SampleService {
  private ps = inject(ProjectService);
  private issues = inject(IssueService);
  private authService = inject(AuthService);
  private search = inject(SearchService);
  private i18n = inject(I18nService);

  /** 作って、プロジェクトの id を返す */
  async create(): Promise<string> {
    const user = auth.currentUser!;
    const uid = user.uid;
    const tz = this.authService.profile()?.timeZone ?? 'Asia/Tokyo';
    const t = (k: string) => this.i18n.t('sample.' + k);

    const pid = await this.ps.create(t('project'), user, { sample: true });
    this.search.invalidate();

    // 課題A：不具合・対応中。サブタスク3つ（完了・対応中・未着手）とコメント1つ
    const na = await this.issues.create(pid, {
      title: t('a.title'), type: 'bug', importance: 'mid', dueAt: endOfDayIn(2, tz), assigneeId: uid,
      doneCriteria: this.i18n.t('doneCriteria.bug'), description: t('a.description'),
      labelIds: ['quality'], occurredOn: null, impact: t('a.impact'),
    }, uid, tz);
    let a = await this.issues.findByNumber(pid, na);
    if (a) {
      const start = TRANSITIONS.find((x) => x.key === 'start')!;
      await this.issues.changeStatus(pid, a, start, EMPTY_STATUS_PAYLOAD, uid, tz);
      a = (await this.issues.get(pid, a.id)) ?? a;
      for (const [i, k] of ['s1', 's2', 's3'].entries()) {
        await this.issues.addSubtask(pid, a, { title: t('a.' + k), assigneeId: uid, dueAt: null, order: i + 1 }, uid, tz);
      }
      const subs = (await this.issues.listSubtasks(pid, a.id)).sort((x, y) => x.order - y.order);
      if (subs[0]) await this.issues.setSubtaskStatus(pid, a.id, subs[0].id, 'done', uid);
      if (subs[1]) await this.issues.setSubtaskStatus(pid, a.id, subs[1].id, 'doing', uid);
      await this.issues.addComment(pid, a.id, t('a.comment'), uid, tz);
    }

    // 課題B：作業・未着手・期限は今日（かんばんで「対応中」へ動かしてもらう用）
    await this.issues.create(pid, {
      title: t('b.title'), type: 'task', importance: 'high', dueAt: endOfDayIn(0, tz), assigneeId: uid,
      doneCriteria: this.i18n.t('doneCriteria.task'), description: t('b.description'),
      labelIds: ['internal'], occurredOn: null, impact: '',
    }, uid, tz);

    return pid;
  }
}