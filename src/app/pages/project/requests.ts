import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Clock } from '../../core/time/clock';
import { IssueRequest } from '../../core/models';
import { relativeTime } from '../../core/time/time';
import { ProjectContext } from './project-context';
import { I18nService, TPipe } from '../../i18n/i18n';

/**
 * 対応待ちの依頼の一覧（見るだけ）。押すと課題が開き、対応・見送り・取り下げは課題の上の箱で行う（入口は1か所）。
 * 管理者は全員の依頼、それ以外の人は自分が出した依頼だけ
 */
@Component({
  selector: 'app-requests',
  imports: [RouterLink, TPipe],
  template: `
    <section>
      <div class="head">
        <h2>{{ 'request.listTitle' | t }}</h2>
        <a class="link" [routerLink]="['/p', ctx.pid(), 'list']">{{ 'trash.back' | t }}</a>
      </div>
      <p class="help">{{ (ctx.role() === 'admin' ? 'request.listHelpAdmin' : 'request.listHelpMember') | t }}</p>
      <ul class="list">
        @for (r of ctx.myRequests(); track r.id) {
          <li>
            <a class="item" [routerLink]="['/p', ctx.pid(), 'i', r.iid]">
              <span class="top">
                <span class="kind" [attr.data-k]="r.kind">{{ 'request.title.' + r.kind | t }}</span>
                <span class="t">#{{ r.number }} {{ r.title }}</span>
                @if (r.kind === 'merge' && r.targetNumber) { <span class="to">→ #{{ r.targetNumber }}</span> }
              </span>
              <span class="reason">{{ r.reason }}</span>
              <span class="meta">{{ r.byName }} · {{ when(r) }}</span>
            </a>
          </li>
        } @empty {
          <li class="empty">{{ 'request.listEmpty' | t }}</li>
        }
      </ul>
    </section>
  `,
  styles: `
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h2 { font-size: 16px; }
    .link { color: var(--primary); text-decoration: none; font-size: 14px; }
    .help { font-size: 12px; color: var(--text-muted); margin: 4px 0 8px; }
    .list { list-style: none; padding: 0; margin: 0; }
    .list li { border-bottom: 1px solid var(--border); }
    .item { display: flex; flex-direction: column; gap: 4px; padding: 10px 8px; color: var(--text); text-decoration: none; }
    .item:hover { background: var(--surface-alt); }
    .top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .kind { font-size: 11px; padding: 1px 8px; border-radius: 10px; background: var(--surface-muted); white-space: nowrap; }
    .kind[data-k='delete'] { background: var(--danger-bg); color: var(--danger-text); }
    .t { overflow-wrap: anywhere; }
    .to { font-size: 13px; color: var(--text-muted); }
    .reason { font-size: 13px; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
    .meta { font-size: 12px; color: var(--text-muted); }
    .empty { padding: 12px 8px; color: var(--text-muted); border-bottom: none; }
  `,
})
export class Requests {
  protected ctx = inject(ProjectContext);
  private clock = inject(Clock);
  private i18n = inject(I18nService);

  when(r: IssueRequest) {
    return relativeTime(r.at.toMillis(), this.i18n.lang(), this.clock.now());
  }
}