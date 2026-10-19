/** コメントの本文を、ふつうの文字・メンション（@名前）・課題の番号（#12）に分けたもの */
export interface CommentSeg { text: string; kind: 'text' | 'mention' | 'issue'; n?: number; }

/** 正規表現で特別な意味を持つ文字を、ただの文字として扱えるようにする（名前に「.」や「(」が入っていても壊れないように） */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 本文を分ける。names＝このコメントでメンションした人の名前（その名前の「@名前」だけを色付きにする）。
 * 長い名前から先に当てる（「山田」と「山田太郎」がいるとき、「@山田太郎」を「@山田」＋「太郎」に割らないため）
 */
export function commentSegments(body: string, names: string[]): CommentSeg[] {
  const alts = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length).map((n) => '@' + escape(n));
  const re = new RegExp([...alts, '#(\\d+)'].join('|'), 'g');
  const out: CommentSeg[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const at = m.index!;
    if (at > last) out.push({ text: body.slice(last, at), kind: 'text' });
    out.push(m[1] ? { text: m[0], kind: 'issue', n: Number(m[1]) } : { text: m[0], kind: 'mention' });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), kind: 'text' });
  return out;
}