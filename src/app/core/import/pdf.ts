import { ImportError } from './parse';

/** PDF で読むページの上限（1ページに数十行として、取り込みの上限 300行に見合う数） */
export const MAX_PDF_PAGES = 20;

/** PDF の文字のかけら（x・y は左下から数えた位置、w は幅、h は文字の高さ） */
interface Piece { s: string; x: number; y: number; w: number; h: number; }
/** 1つのマス（かけらをつなげたもの） */
interface Cell { s: string; x: number; end: number; }

/**
 * 表の PDF を、表（行 × 列の文字）にする。1行目は見出し。
 * PDF は「この文字を、この位置に置く」の束でしかないので、位置から表を組み立て直す（だいたい合うまで。
 * 残りは「読み取りの確認」で人が直す）。pdf.js は大きいので、PDF を選んだときに初めて読み込む
 */
export async function readPdf(buf: ArrayBuffer): Promise<string[][]> {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const task = pdfjs.getDocument({ data: new Uint8Array(buf) });
    const doc = await task.promise;
    try {
        if (doc.numPages > MAX_PDF_PAGES) throw new ImportError('tooManyPages');
        const lines: Piece[][] = [];
        for (let p = 1; p <= doc.numPages; p++) {
            const content = await (await doc.getPage(p)).getTextContent();
            // ① 文字を座標つきで取り出す（空白だけのかけらは捨てる）
            const pieces = (content.items as { str?: string; transform?: number[]; width?: number; height?: number }[])
                .filter((it) => it.str?.trim() && it.transform)
                .map((it) => ({
                    s: it.str!, x: it.transform![4], y: it.transform![5], w: it.width ?? 0,
                    h: it.height || Math.abs(it.transform![3]) || 10,
                }));
            lines.push(...toLines(pieces));
        }
        // 文字が1つもない＝スキャンした（写真の）PDF
        if (!lines.length) throw new ImportError('noText');
        return toTable(lines);
    } finally {
        // 作業員（ワーカー）と、読み込んだ PDF を片づける
        await task.destroy();
    }
}

/**
 * ② 1ページの文字のかけらを、上から順に行にまとめる。
 * かけらどうしは、ここではつながない（スプレッドシートの PDF は、マスのすき間がとても狭く、
 * つなぐと隣の列の文字までくっつくため。つなぐのは、列に振り分けたあと、同じ列の中だけ）
 */
function toLines(pieces: Piece[]): Piece[][] {
    // PDF の y は下から数えるので、大きいほど上
    const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Piece[][] = [];
    for (const p of sorted) {
        const last = rows[rows.length - 1];
        // 高さが、文字の高さの半分以内しか違わなければ、同じ行（定規を横に当てるイメージ）
        if (last && Math.abs(last[0].y - p.y) <= Math.max(2, p.h * 0.5)) last.push(p);
        else rows.push([p]);
    }
    return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

/** 見出しの行だけは、すぐ隣のかけらをつなげる（「完了」「条件」のように細切れになった見出しを1つに） */
function headerCells(line: Piece[]): Cell[] {
    const cells: Cell[] = [];
    for (const p of line) {
        const c = cells[cells.length - 1];
        if (c && p.x - c.end < p.h * 0.25) {
            c.s += p.s;
            c.end = Math.max(c.end, p.x + p.w);
        } else {
            cells.push({ s: p.s, x: p.x, end: p.x + p.w });
        }
    }
    return cells.map((c) => ({ ...c, s: c.s.trim() })).filter((c) => c.s);
}

/**
 * ③ 見出しの左端の位置を目印に、かけらを列に振り分け、同じ列の中だけでつなげる。
 * ④ 2ページ目以降の見出しのくり返しと、ページ番号の行は捨てる。
 * 折り返した文はつながない（当て推量が外れると、全部の行が1行に吸い込まれるため）。「↑」で人が直す
 */
function toTable(lines: Piece[][]): string[][] {
    // 見出し：マスが2つ以上ある最初の行（その上の「課題一覧」のような題は捨てる）
    const hi = lines.findIndex((l) => headerCells(l).length >= 2);
    if (hi < 0) throw new ImportError('noText');
    const header = headerCells(lines[hi]);
    const starts = header.map((c) => c.x);
    // 列の境目：次の列の見出しの左端の、少し手前。右寄せの数字（番号など）も、自分の列に残る
    const TOL = 3;
    const colOf = (x: number) => {
        let k = 0;
        starts.forEach((s, i) => { if (x >= s - TOL) k = i; });
        return k;
    };
    const headText = header.map((c) => c.s).join('|');
    const rows: string[][] = [header.map((c) => c.s)];
    for (const l of lines.slice(hi + 1)) {
        if (headerCells(l).map((c) => c.s).join('|') === headText) continue;
        if (l.length === 1 && /^[-–\s]*\d+(\s*\/\s*\d+)?[-–\s]*$/.test(l[0].s)) continue;
        const row = header.map(() => '');
        const ends = header.map(() => 0);
        for (const p of l) {
            // 列の境目をまたいだかけら（同じ書体で続けて書かれた「1 zukemaguro」など）は、境目で切る
            const k0 = colOf(p.x);
            // 右端が次の列に少しはみ出しただけなら、切らない
            const k1 = colOf(p.x + p.w - TOL);
            const cuts = [];
            for (let k = k0 + 1; k <= k1; k++) cuts.push({ col: k, at: starts[k] - TOL });
            for (const seg of splitPiece(p, k0, cuts)) {
                const s = seg.s.trim();
                if (!s) continue;
                const k = seg.col;
                // 同じ列の中：すき間があれば空白を挟み、なければ詰める（1つの言葉が細切れになっていることがあるため）
                row[k] = !row[k] ? s : row[k] + (seg.x - ends[k] > p.h * 0.15 ? ' ' : '') + s;
                ends[k] = seg.end;
            }
        }
        if (row.some(Boolean)) rows.push(row);
    }
    return rows;
}

/**
* 列の境目をまたいだかけらを、境目で切る。どの文字が境目の上にあるかは、文字の幅から見積もる
* （日本語などの全角は1、英数字などの半角は0.5として数える）。
* 近くに空白があれば、そこで切る（言葉の途中で切らないように）。切ったあとの後ろは、またいだ先の列に入れる
*/
function splitPiece(p: Piece, firstCol: number, cuts: { col: number; at: number }[]) {
    const whole = [{ col: firstCol, s: p.s, x: p.x, end: p.x + p.w }];
    if (!cuts.length) return whole;
    const chars = [...p.s];
    const unit = (c: string) => (/[\u0000-\u00ff\uff61-\uff9f]/.test(c) ? 0.5 : 1);
    const total = chars.reduce((n, c) => n + unit(c), 0) || 1;
    // 各文字の左端の見積もり（最後に、かけらの右端を足しておく）
    const xAt: number[] = [];
    let acc = 0;
    for (const c of chars) {
        xAt.push(p.x + (p.w * acc) / total);
        acc += unit(c);
    }
    xAt.push(p.x + p.w);

    // 切る位置（文字の番号）と、そこから先が入る列
    const at: { i: number; col: number }[] = [];
    for (const c of cuts) {
        let i = xAt.findIndex((x) => x >= c.at);
        if (i <= 0 || i >= chars.length) continue;
        for (let d = 0; d <= 3; d++) {
            if (/\s/.test(chars[i - d] ?? '')) { i -= d; break; }
            if (/\s/.test(chars[i + d] ?? '')) { i += d; break; }
        }
        if (i > 0 && i < chars.length && !at.some((a) => a.i === i)) at.push({ i, col: c.col });
    }
    if (!at.length) return whole;
    at.sort((a, b) => a.i - b.i);

    const out: { col: number; s: string; x: number; end: number }[] = [];
    let from = 0;
    let col = firstCol;
    for (const cut of [...at, { i: chars.length, col: -1 }]) {
        // 切った所の空白は飛ばして、最初の文字の位置を始まりにする
        let st = from;
        while (st < cut.i && /\s/.test(chars[st])) st++;
        const s = chars.slice(st, cut.i).join('');
        if (s.trim()) out.push({ col, s, x: xAt[st], end: xAt[cut.i] });
        from = cut.i;
        col = cut.col;
    }
    return out;
}