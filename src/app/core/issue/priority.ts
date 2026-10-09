import { Issue, Level } from '../models';

const HOUR = 60 * 60 * 1000;

/** 緊急度：期限までの残り時間から決める（保存せず、毎回計算する） */
export function urgencyOf(dueMs: number, nowMs = Date.now()): Level {
  const left = dueMs - nowMs;
  if (left <= 24 * HOUR) return 'high'; // 24時間以内、または期限切れ
  if (left <= 72 * HOUR) return 'mid';  // 3日以内
  return 'low';
}

/** [重要度][緊急度] → 優先度 */
const TABLE: Record<Level, Record<Level, Level>> = {
  high: { high: 'high', mid: 'high', low: 'mid' },
  mid:  { high: 'high', mid: 'mid',  low: 'low' },
  low:  { high: 'mid',  mid: 'low',  low: 'low' },
};

type PriorityInput = Pick<Issue, 'importance' | 'priorityOverride' | 'dueAt'>;

export function priorityOf(i: PriorityInput, nowMs = Date.now()): Level {
  return i.priorityOverride ?? TABLE[i.importance][urgencyOf(i.dueAt.toMillis(), nowMs)];
}

const RANK: Record<Level, number> = { high: 0, mid: 1, low: 2 };

/** やる順番：優先度が高い順、同じなら期限が近い順 */
export function compareIssues(a: PriorityInput, b: PriorityInput, nowMs = Date.now()): number {
  return RANK[priorityOf(a, nowMs)] - RANK[priorityOf(b, nowMs)]
    || a.dueAt.toMillis() - b.dueAt.toMillis();
}

/** 印の棒を何本塗るか（高＝3本、中＝2本、低＝1本） */
export const PRIORITY_BARS: Record<Level, number> = { high: 3, mid: 2, low: 1 };

/** 優先度を手動で変更しているか */
export function isManualPriority(i: Pick<Issue, 'priorityOverride'>): boolean {
  return i.priorityOverride != null;
}