/** 取り込むファイルを、表（行 × 列の文字）にする。1行目は見出し。Excel は手順7で足す */

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** 取り込みの失敗（code は翻訳キー importPage.errors.〇〇） */
export class ImportError extends Error {
  constructor(readonly code: 'tooBig' | 'badType' | 'empty') {
    super(code);
  }
}

/** 読んだ表。CSV は1つ、Excel はシートの数だけ（課題の行がないシートは除く） */
export interface SheetTable { name: string; rows: string[][]; }

export async function readTables(file: File): Promise<SheetTable[]> {
  if (file.size > MAX_FILE_BYTES) throw new ImportError('tooBig');
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  let tables: SheetTable[];
  if (['csv', 'tsv', 'txt'].includes(ext)) {
    const text = decode(await file.arrayBuffer());
    tables = [{ name: file.name, rows: parseDelimited(text, ext === 'tsv' || looksTabbed(text) ? '\t' : ',') }];
  } else if (ext === 'xlsx' || ext === 'xls') {
    tables = await readExcel(await file.arrayBuffer());
  } else {
    throw new ImportError('badType');
  }
  tables = tables.filter((t) => t.rows.length >= 2); // 見出しだけ、または空のものは除く
  if (!tables.length) throw new ImportError('empty');
  return tables;
}

/**
 * Excel を読む。SheetJS は大きいので、取り込むときに初めて読み込む（最初の読み込みを増やさない）。
 * raw: true で、日付のマスは「日付の数（シリアル値）」のまま受け取る。表示どおりの文字にすると、
 * 書式によって 10/20/26 のような読み違えやすい形になるため。読み替えは convert.ts の parseDate が行う
 */
async function readExcel(buf: ArrayBuffer): Promise<SheetTable[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  return wb.SheetNames.map((name) => {
    const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    return { name, rows: tidy(raw.map((r) => r.map((v) => (v == null ? '' : String(v))))) };
  });
}

/**
 * 文字コード：まず UTF-8 で読み、読めなければ Shift_JIS で読み直す。
 * 日本語の Excel で「CSV」として保存すると Shift_JIS になることが多いため。
 * UTF-8 の先頭の BOM は、TextDecoder が取り除く
 */
function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

/** 1行目にカンマがなく、タブがあれば、タブ区切りとみなす */
function looksTabbed(text: string): boolean {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  return first.includes('\t') && !first.includes(',');
}

/**
 * CSV（区切りは sep）を表にする。" で囲んだ中のカンマ・改行、"" は " 1文字、の決まりに従う。
 * 書き出し（csv.ts）と逆の決まりなので、書き出したファイルはそのまま読める
 */
export function parseDelimited(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === sep) {
      row.push(cell); cell = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++; // CRLF は1つの改行
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return tidy(rows);
}

/** 空の行（Excel が末尾に足しがち）を除き、列の数をそろえる。CSV と Excel で同じ形にする */
function tidy(rows: string[][]): string[][] {
  const filled = rows.filter((r) => r.some((v) => v.trim() !== ''));
  const width = Math.max(0, ...filled.map((r) => r.length));
  return filled.map((r) => [...r, ...Array(width - r.length).fill('')]);
}