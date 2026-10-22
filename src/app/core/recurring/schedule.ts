import { RecurSpec } from '../models';

/*
 * 定期課題の「次はいつ作るか」の計算。
 * ※ functions/src/index.ts の partsIn・zonedMs・nextOccurrence と同じにすること（片方を変えたら、もう片方も変える）
 */

const DAY = 24 * 60 * 60 * 1000;

/** 瞬間を、tz での年・月・日・時・分・秒に分ける */
function partsIn(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), mi: g('minute'), s: g('second') };
}

/** tz での y年m月d日 h:mi の瞬間（ミリ秒）。d が月の日数を超えても、翌月に繰り上がる */
function zonedMs(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (ms: number) => {
    const p = partsIn(ms, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
  };
  // 夏時間の切り替わりの近くでずれないよう、1回だけ合わせ直す
  return guess - offset(guess - offset(guess));
}

function lastDay(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** afterMs より後で、いちばん近い「作る時刻」（ミリ秒） */
export function nextOccurrence(s: RecurSpec, afterMs: number): number {
  const start = partsIn(afterMs, s.tz);
  const h = Math.floor(s.time / 60);
  const mi = s.time % 60;
  // 今日から1日ずつ見ていく（毎月でも、400日以内に必ず当たる）
  for (let k = 0; k < 400; k++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + k));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const hit = s.freq === 'daily'
      || (s.freq === 'weekly' && s.weekdays.includes(day.getUTCDay()))
      || (s.freq === 'monthly' && d === Math.min(s.monthDay, lastDay(y, m)));
    if (!hit) continue;
    const t = zonedMs(y, m, d, h, mi, s.tz);
    if (t > afterMs) return t;
  }
  return afterMs + 365 * DAY; // 当たらない決まり（曜日が空など）。画面で止めているので、ふつうは来ない
}

/** 0時からの分を「9:05」の形に */
export function hhmm(time: number) {
  return `${Math.floor(time / 60)}:${String(time % 60).padStart(2, '0')}`;
}

/**
 * 定期課題の先の回の期限（ミリ秒）を、作る時刻が untilMs までのぶんだけ並べる（カレンダーに薄く出すため）。
 * 期限は、作る日（雛形のタイムゾーンの暦）の dueDays 日後の 23:59（関数の runRecurring と同じ決まり）
 */
export function upcomingDues(
  t: RecurSpec & { nextAt: { toMillis(): number }; dueDays: number }, untilMs: number, max = 62,
): number[] {
  const out: number[] = [];
  let at = t.nextAt.toMillis();
  for (let k = 0; k < max && at <= untilMs; k++) {
    const p = partsIn(at, t.tz);
    out.push(zonedMs(p.y, p.m, p.d + t.dueDays, 23, 59, t.tz));
    at = nextOccurrence(t, at);
  }
  return out;
}