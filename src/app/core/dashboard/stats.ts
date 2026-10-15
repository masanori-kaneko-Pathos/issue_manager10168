import { CAUSE_CATEGORIES, CauseCategory, Effect, Issue, Level, Member } from '../models';
import { isStale, priorityFrom, priorityOf, urgencyOf } from '../issue/priority';
import { dateKey, zonedTime } from '../time/time';

const DAY = 24 * 60 * 60 * 1000;
const LEVELS: Level[] = ['high', 'mid', 'low'];

export type Period = 'thisWeek' | 'lastWeek' | 'thisMonth';

/** 未完了（未着手・対応中・保留）か */
export const isActive = (i: Issue) => i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';

/**
 * 期間の始まりと終わり（ミリ秒。終わりは含まない）。
 * 見る人のタイムゾーンの暦で区切る。週はカレンダーと同じ日曜はじまり
 */
export function periodRange(p: Period, nowMs: number, tz: string): { from: number; to: number } {
  const [y, m, d] = dateKey(new Date(nowMs), tz).split('-').map(Number);
  // 暦の計算は、UTC の「日付だけ」の Date で行い、最後に tz の 0:00 に直す（カレンダーと同じやり方）
  const midnight = (dt: Date) =>
    zonedTime(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0, 0, tz).getTime();
  if (p === 'thisMonth') {
    return { from: midnight(new Date(Date.UTC(y, m - 1, 1))), to: midnight(new Date(Date.UTC(y, m, 1))) };
  }
  const today = new Date(Date.UTC(y, m - 1, d));
  const sunday = new Date(Date.UTC(y, m - 1, d - today.getUTCDay()));
  const start = p === 'thisWeek' ? sunday : new Date(sunday.getTime() - 7 * DAY);
  return { from: midnight(start), to: midnight(new Date(start.getTime() + 7 * DAY)) };
}

// ---- 今の状況（期間に関係なく「今」） ----

export interface NowStats { active: number; overdue: number; stale: number; high: number; }

export function nowStats(issues: Issue[], nowMs: number, staleDays: number): NowStats {
  const a = issues.filter(isActive);
  return {
    active: a.length,
    overdue: a.filter((i) => i.dueAt.toMillis() < nowMs).length,
    stale: a.filter((i) => isStale(i, staleDays, nowMs)).length,
    // 手動で変えた優先度も含めた、今の優先度
    high: a.filter((i) => priorityOf(i, nowMs) === 'high').length,
  };
}

/** 3×3のマス。並びは 重要度 大→小（行）× 緊急度 高→低（列） */
export interface Cell { importance: Level; urgency: Level; priority: Level; issues: Issue[]; }

export function matrix(issues: Issue[], nowMs: number): Cell[] {
  const cells: Cell[] = LEVELS.flatMap((importance) => LEVELS.map((urgency) => ({
    importance, urgency, priority: priorityFrom(importance, urgency), issues: [] as Issue[],
  })));
  for (const i of issues.filter(isActive)) {
    const urgency = urgencyOf(i.dueAt.toMillis(), nowMs);
    cells.find((c) => c.importance === i.importance && c.urgency === urgency)?.issues.push(i);
  }
  for (const c of cells) c.issues.sort((a, b) => a.dueAt.toMillis() - b.dueAt.toMillis());
  return cells;
}

// ---- 期間の集計 ----

const inRange = (ms: number | undefined, from: number, to: number) => ms !== undefined && ms >= from && ms < to;

/**
 * 期間内に解決済みになった課題。今も解決済み・クローズのものだけ
 * （差し戻した課題は、もう一度解決するまで数えない。却下は「解決」ではないので数えない）
 */
export function resolvedIn(issues: Issue[], from: number, to: number): Issue[] {
  return issues.filter((i) => (i.status === 'resolved' || i.status === 'closed')
    && inRange(i.resolvedAt?.toMillis(), from, to));
}

/** 登録から解決までの平均日数（小数1けた）。0件なら null */
export function avgResolveDays(resolved: Issue[]): number | null {
  if (!resolved.length) return null;
  const sum = resolved.reduce((s, i) => s + (i.resolvedAt!.toMillis() - i.createdAt.toMillis()), 0);
  return Math.round((sum / resolved.length / DAY) * 10) / 10;
}

/** 原因カテゴリごとの件数（多い順。0件のカテゴリは出さない） */
export function byCause(resolved: Issue[]): { cat: CauseCategory; n: number }[] {
  return CAUSE_CATEGORIES
    .map((cat) => ({ cat, n: resolved.filter((i) => i.causeCategory === cat).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n);
}

export interface MemberRow {
  uid: string;
  name: string;
  assigned: number;      // 今、担当している未完了の課題
  overdue: number;       // そのうち期限切れ
  resolved: number;      // 期間内に解決した課題
  onTime: number | null; // そのうち、初回の期限までに解決した割合（0〜1。0件なら null）
  effect: Record<Effect, number>; // 期間内にクローズした課題の効果確認
}

/** メンバー別の対応状況。閲覧者は担当を持たないので出さない。並びは名前順（数で並べない＝ランキングにしない） */
export function memberRows(members: Member[], issues: Issue[], from: number, to: number, nowMs: number): MemberRow[] {
  const resolved = resolvedIn(issues, from, to);
  const closed = issues.filter((i) => i.status === 'closed' && inRange(i.closedAt?.toMillis(), from, to));
  return members
    .filter((m) => m.role !== 'viewer')
    .map((m) => {
      const mine = issues.filter((i) => isActive(i) && i.assigneeId === m.uid);
      const done = resolved.filter((i) => i.assigneeId === m.uid);
      // 初回の期限（firstDueAt）がない古い課題は、今の期限で代わりに数える
      const onTimeN = done.filter((i) => i.resolvedAt!.toMillis() <= (i.firstDueAt ?? i.dueAt).toMillis()).length;
      const effect: Record<Effect, number> = { yes: 0, partial: 0, no: 0 };
      for (const i of closed) if (i.assigneeId === m.uid && i.effect) effect[i.effect]++;
      return {
        uid: m.uid,
        name: m.displayName,
        assigned: mine.length,
        overdue: mine.filter((i) => i.dueAt.toMillis() < nowMs).length,
        resolved: done.length,
        onTime: done.length ? onTimeN / done.length : null,
        effect,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}