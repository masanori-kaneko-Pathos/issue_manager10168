const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** その瞬間における、timeZone の UTC からのずれ（ミリ秒） */
function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** timeZone での「年月日 時:分」を、瞬間（Date）に変換する */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), timeZone);
  t = guess - offsetMs(new Date(t), timeZone); // 夏時間の切り替わりの補正
  return new Date(t);
}

/** timeZone で、今日から days 日後の 23:59 */
export function endOfDayIn(days: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number); // en-CA は YYYY-MM-DD
  const base = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 23, 59, timeZone);
}

/** datetime-local の値（例 2026-10-09T18:00）を、timeZone の時刻として解釈する */
export function parseLocalInput(value: string, timeZone: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  return m ? zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], timeZone) : null;
}

export function formatDateTime(date: Date, timeZone: string, lang: 'ja' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone, dateStyle: 'medium', timeStyle: 'short',
  }).format(date);
}

/** 残り時間の表示用（翻訳キーと数値）。1日以上は日数、それ未満は時間数 */
export function remainingOf(dueMs: number, nowMs = Date.now()): { key: string; n: number } {
  const diff = dueMs - nowMs;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / DAY);
  if (days > 0) return { key: diff < 0 ? 'due.overDays' : 'due.leftDays', n: days };
  return { key: diff < 0 ? 'due.overHours' : 'due.leftHours', n: Math.max(1, Math.floor(abs / HOUR)) };
}

/** 瞬間を、timeZone での datetime-local の値（例 2026-10-09T18:00）にする */
export function toLocalInput(date: Date, timeZone: string): string {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(date);
    const g = (t: string) => p.find((x) => x.type === t)!.value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  }

  /** 「5時間前」「5 hours ago」のような相対的な表示 */
export function relativeTime(ms: number, lang: 'ja' | 'en', nowMs = Date.now()): string {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const sec = Math.round((ms - nowMs) / 1000); // 過去はマイナス
    const abs = Math.abs(sec);
    if (abs < 60) return rtf.format(sec, 'second');
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    if (abs < 86400 * 365) return rtf.format(Math.round(sec / (86400 * 30)), 'month');
    return rtf.format(Math.round(sec / (86400 * 365)), 'year');
  }