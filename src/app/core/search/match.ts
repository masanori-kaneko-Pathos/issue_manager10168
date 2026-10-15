import { Issue } from '../models';

/** 全角・半角、大文字・小文字をそろえる（全角の空白も半角になる） */
export const normalize = (s: string) => s.normalize('NFKC').toLowerCase();

/** 検索語を空白で分ける（そろえたあと） */
export function terms(q: string): string[] {
  return normalize(q).split(/\s+/).filter(Boolean);
}

export interface Seg { text: string; hit: boolean; }

/** そろえた文字で探し、見つかった位置を「元の文字」の位置で返す（q はそろえ済み） */
export function findMatch(text: string, q: string): [number, number] | null {
  let norm = '';
  const map: number[] = []; // そろえた文字の位置 → 元の文字の位置
  for (let i = 0; i < text.length; i++) {
    const n = text[i].normalize('NFKC').toLowerCase();
    norm += n;
    for (let k = 0; k < n.length; k++) map.push(i);
  }
  const at = norm.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

/** 一致した部分とそれ以外に分ける（from〜to の範囲だけ） */
export function segments(text: string, range: [number, number] | null, from = 0, to = text.length): Seg[] {
  if (!range) return [{ text: text.slice(from, to), hit: false }];
  const [s, e] = range;
  return [
    { text: text.slice(from, s), hit: false },
    { text: text.slice(s, e), hit: true },
    { text: text.slice(e, to), hit: false },
  ].filter((g) => g.text);
}

/** タイトル以外で探す項目（見出しの翻訳キーと中身）。
 *  完了条件は種別の初期文がそのまま入っていることが多く、当たりすぎるので外す */
export function otherFields(i: Issue): [string, string | undefined][] {
  return [
    ['issue.description', i.description],
    ['issue.impact', i.impact],
    ['workflow.cause', i.cause],
    ['workflow.countermeasure', i.countermeasure],
    ['workflow.learning', i.learning],
  ];
}

/** すべての語が、どこかの項目に入っているか（語ごとに別の項目でもよい） */
export function issueMatches(i: Issue, ts: string[]): boolean {
  const texts = [i.title, '#' + i.number, ...otherFields(i).map(([, t]) => t ?? '')].map(normalize);
  return ts.every((t) => texts.some((x) => x.includes(t)));
}

/** 並びの順位（小さいほど上）：0＝番号そのもの（「12」「#12」）、1＝タイトルに全部の語、2＝それ以外 */
export function rankOf(i: Issue, ts: string[]): number {
  if (ts.length === 1 && ts[0].replace(/^#/, '') === String(i.number)) return 0;
  const title = normalize(i.title);
  return ts.every((t) => title.includes(t)) ? 1 : 2;
}

export interface Hit { title: Seg[]; field?: string; snippet?: Seg[]; }

/** 一致した場所の見せ方。タイトルにあればタイトルを光らせ、なければ最初に当たった項目の前後を抜き出す */
export function hitOf(i: Issue, ts: string[]): Hit {
  for (const t of ts) {
    const m = findMatch(i.title, t);
    if (m) return { title: segments(i.title, m) };
  }
  for (const [field, text] of otherFields(i)) {
    if (!text) continue;
    for (const t of ts) {
      const m = findMatch(text, t);
      if (!m) continue;
      // 一致した部分の前20文字・後ろ40文字だけ
      const from = Math.max(0, m[0] - 20);
      const to = Math.min(text.length, m[1] + 40);
      return {
        title: segments(i.title, null),
        field,
        snippet: [
          ...(from > 0 ? [{ text: '…', hit: false }] : []),
          ...segments(text, m, from, to),
          ...(to < text.length ? [{ text: '…', hit: false }] : []),
        ],
      };
    }
  }
  return { title: segments(i.title, null) }; // 番号で当たったもの
}