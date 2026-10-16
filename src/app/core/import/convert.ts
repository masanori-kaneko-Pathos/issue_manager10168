import {
    CAUSE_CATEGORIES, CauseCategory, Effect, ISSUE_TYPES, IssueStatus, IssueType, Label, Level, Member, Role,
  } from '../models';
  import { normalize } from '../search/match';
  import { zonedTime } from '../time/time';
  import { ja } from '../../i18n/ja';
  import { en } from '../../i18n/en';
  
  const DAY = 24 * 60 * 60 * 1000;
  /** 1回に取り込める行の数（1件ずつ書くので、待ち時間の上限として） */
  export const MAX_ROWS = 300;
  
  /** 取り込める項目（うちの CSV の列と同じ名前。updatedAt と優先度は取り込まない） */
  export type Field =
    | 'number' | 'title' | 'type' | 'status' | 'importance' | 'due' | 'assignee' | 'reporter' | 'labels'
    | 'occurredOn' | 'impact' | 'doneCriteria' | 'description' | 'cause' | 'countermeasure' | 'causeCategory'
    | 'effect' | 'learning' | 'createdAt' | 'resolvedAt' | 'closedAt';
  export const FIELDS: Field[] = [
    'title', 'type', 'status', 'importance', 'due', 'assignee', 'reporter', 'labels', 'occurredOn', 'impact',
    'doneCriteria', 'description', 'cause', 'countermeasure', 'causeCategory', 'effect', 'learning',
    'createdAt', 'resolvedAt', 'closedAt', 'number',
  ];
  
  /** 比べるためにそろえる（全角半角・大文字小文字・空白・よくある記号を無視） */
  const key = (s: string) => normalize(s).replace(/[\s_\-・:：()（）［］[\]#＃]/g, '');
  
  /** 見出しのよくある言い方。うちの CSV の見出し（日英）は、翻訳から自動で足す */
  const SYNONYMS: Record<Field, string[]> = {
    number: ['番号', 'no', 'id', 'キー', 'key', 'issue number', 'issue key'],
    title: ['タイトル', '件名', '題名', '課題', '課題名', '概要', 'subject', 'summary', 'title', 'name'],
    type: ['種別', '種類', '区分', 'type', 'issue type'],
    status: ['ステータス', '状態', '状況', 'status', 'state'],
    importance: ['重要度', 'importance', 'severity'],
    due: ['期限', '期日', '期限日', '締切', '締め切り', '納期', 'due', 'due date', 'deadline'],
    assignee: ['担当者', '担当', '担当者名', 'assignee', 'owner', 'assigned to'],
    reporter: ['提起者', '起票者', '登録者', '報告者', '作成者', 'reporter', 'created by', 'author'],
    labels: ['ラベル', 'タグ', 'labels', 'label', 'tags'],
    occurredOn: ['発生日', 'occurred', 'occurred on'],
    impact: ['影響範囲', '影響', 'impact'],
    doneCriteria: ['完了条件', '受入条件', 'done criteria', 'acceptance criteria'],
    description: ['内容', '詳細', '説明', '本文', 'description', 'details', 'body'],
    cause: ['原因', 'cause', 'root cause'],
    countermeasure: ['対策', '対応内容', 'countermeasure', 'fix'],
    causeCategory: ['原因カテゴリ', 'cause category'],
    effect: ['効果確認', 'effect'],
    learning: ['学び', 'learning', 'lessons learned'],
    createdAt: ['登録日時', '登録日', '作成日', '作成日時', '起票日', 'created', 'created at'],
    resolvedAt: ['解決日時', '解決日', 'resolved', 'resolved at'],
    closedAt: ['クローズ日時', '完了日', '完了日時', 'closed', 'closed at'],
  };
  /** 重要度の列がないときだけ、優先度の列を重要度として使う（他のツールは「優先度」しか持たないことが多い） */
  const PRIORITY_SYNONYMS = ['優先度', 'priority'];
  
  const cols = (d: { csv: { cols: Record<string, string> } }, f: string) => d.csv.cols[f];
  
  /** 見出しの行から、列ごとの項目を当てる。当たらない列は null（取り込まない） */
  export function guessColumns(headers: string[]): (Field | null)[] {
    const out: (Field | null)[] = headers.map(() => null);
    const used = new Set<Field>();
    headers.forEach((h, i) => {
      const k = key(h);
      const f = FIELDS.find((f) => !used.has(f)
        && [...SYNONYMS[f], cols(ja, f), cols(en, f)].filter(Boolean).some((s) => key(s) === k));
      if (f) {
        out[i] = f;
        used.add(f);
      }
    });
    if (!used.has('importance')) {
      const i = headers.findIndex((h, j) => !out[j] && PRIORITY_SYNONYMS.some((s) => key(s) === key(h)));
      if (i >= 0) out[i] = 'importance';
    }
    return out;
  }
  
  // ---- 値の読み替え ----
  
  /** 言葉 → 値の表を、翻訳（日英）とよくある言い方から作る */
  function lookup<T extends string>(base: Record<T, string[]>, ...dicts: Record<string, string>[]): Map<string, T> {
    const m = new Map<string, T>();
    for (const [v, words] of Object.entries(base) as [T, string[]][]) {
      for (const w of [v, ...words, ...dicts.map((d) => d[v]).filter(Boolean)]) m.set(key(w), v);
    }
    return m;
  }
  
  const TYPE_WORDS = lookup<IssueType>({
    bug: ['バグ', '障害', '不具合', 'defect'],
    request: ['要望', '改善', '機能追加', 'feature', 'improvement', 'enhancement'],
    question: ['質問', '確認', '問い合わせ'],
    task: ['タスク', '作業', 'その他', 'other'],
    risk: ['リスク', '懸念'],
  }, ja.issueTypes, en.issueTypes);
  
  const LEVEL_WORDS = lookup<Level>({
    high: ['大', '高', '重要', '緊急', 'a', '1', 'highest', 'critical', 'urgent'],
    mid: ['中', '普通', '通常', 'b', '2', 'medium', 'normal'],
    low: ['小', '低', 'c', '3', 'lowest', 'minor'],
  }, ja.importance, en.importance, ja.priority, en.priority);
  
  const STATUS_WORDS = lookup<Exclude<IssueStatus, 'deleted'>>({
    open: ['未着手', '未対応', '新規', 'to do', 'todo', 'new', 'backlog'],
    in_progress: ['対応中', '処理中', '進行中', 'in progress', 'doing'],
    on_hold: ['保留', '待ち', 'on hold', 'pending'],
    resolved: ['解決済み', '処理済み', 'resolved'],
    closed: ['クローズ', '完了', '終了', 'closed', 'done'],
    rejected: ['却下', 'rejected', "won't fix", 'wontfix'],
  }, ja.status, en.status);
  
  const CAUSE_WORDS = lookup<CauseCategory>(
    Object.fromEntries(CAUSE_CATEGORIES.map((c) => [c, []])) as unknown as Record<CauseCategory, string[]>,
    ja.causeCategories, en.causeCategories);
  
  const EFFECT_WORDS = lookup<Effect>({
    yes: ['あり', '効果あり'], partial: ['一部'], no: ['なし'],
  }, ja.workflow.effectOpts, en.workflow.effectOpts);
  
  interface DateParts { y: number; m: number; d: number; h: number; mi: number; time: boolean; }
  
  /** 日付を読む：2026/10/20、2026-10-20 18:00、2026年10月20日、Excel の日付の数（シリアル値） */
  export function parseDate(v: string): DateParts | null {
    const s = normalize(v).trim();
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const dt = new Date(Math.round((Number(s) - 25569) * DAY)); // 1970-01-01 が 25569
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
        h: dt.getUTCHours(), mi: dt.getUTCMinutes(), time: Number(s) % 1 !== 0 };
    }
    const m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?(?:[\st]+(\d{1,2}):(\d{2})(?::\d{2})?)?/);
    if (!m) return null;
    const p = { y: +m[1], m: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, time: !!m[4] };
    if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31 || p.h > 23 || p.mi > 59) return null;
    return p;
  }
  
  const pad = (n: number) => String(n).padStart(2, '0');
  
  // ---- 1行ずつの下書き ----
  
  /** 取り込む値（登録の NewIssue ＋ 取り込みだけで使うもの） */
  export interface ImportValues {
    title: string;
    type: IssueType;
    importance: Level;
    dueAt: Date;
    assigneeId: string;
    reporterId: string;
    doneCriteria: string;
    description: string;
    labelIds: string[];
    occurredOn: string | null;
    impact: string;
    status: Exclude<IssueStatus, 'deleted'>;
    createdAt: Date | null;   // null＝取り込んだ時刻
    resolvedAt: Date | null;
    closedAt: Date | null;
    cause: string;
    countermeasure: string;
    causeCategory: CauseCategory | null;
    effect: Effect | null;
    learning: string;
  }
  
  /** 行に付ける知らせ。error は取り込めない、skip は最初はチェックを外す、warn は注意だけ */
  export interface Note { level: 'error' | 'skip' | 'warn'; key: string; params?: Record<string, string>; }
  
  export interface Draft {
    line: number;      // ファイルの何行目か（見出しが1行目）
    include: boolean;  // 取り込むか（確認画面のチェック）
    values: ImportValues;
    notes: Note[];
  }
  
  export interface ConvertContext {
    role: Role;
    myUid: string;
    members: Member[];
    labels: Label[];
    /** プロジェクトの今の課題のタイトル（削除フォルダを除く）。重複の見つけ方に使う */
    existingTitles: string[];
    tz: string;
    nowMs: number;
    defaults: { type: IssueType; importance: Level; dueDays: number };
    t: (k: string, p?: Record<string, string>) => string;
  }
  
  const ACTIVE_FOR_MEMBER: IssueStatus[] = ['open', 'in_progress'];
  
  /** 表（1行目は見出し）と列の対応から、1行ずつの下書きを作る。書き込みはしない */
  export function convertRows(table: string[][], mapping: (Field | null)[], c: ConvertContext): Draft[] {
    const col = (f: Field) => mapping.indexOf(f);
    const seen = new Set(c.existingTitles.map(key));
    const memberByName = new Map(c.members.map((m) => [key(m.displayName), m]));
    const labelByName = new Map(c.labels.map((l) => [key(l.name), l]));
    const label = (f: string) => c.t('csv.cols.' + f);
  
    return table.slice(1, MAX_ROWS + 1).map((row, idx) => {
      const notes: Note[] = [];
      const get = (f: Field) => (col(f) >= 0 ? (row[col(f)] ?? '').trim() : '');
      const warn = (k: string, params?: Record<string, string>) => notes.push({ level: 'warn', key: k, params });
  
      // タイトル（必須。200字まで）
      let title = get('title').replace(/\s+/g, ' ');
      if (!title) notes.push({ level: 'error', key: 'importPage.notes.noTitle' });
      if (title.length > 200) { title = title.slice(0, 200); warn('importPage.notes.truncated', { field: label('title') }); }
  
      // 種別・重要度（空・不明は、決めた値で埋める）
      const type = TYPE_WORDS.get(key(get('type'))) ?? c.defaults.type;
      if (!TYPE_WORDS.has(key(get('type')))) {
        warn('importPage.notes.filled', { field: label('type'), v: c.t('issueTypes.' + type) });
      }
      const importance = LEVEL_WORDS.get(key(get('importance'))) ?? c.defaults.importance;
      if (!LEVEL_WORDS.has(key(get('importance')))) {
        warn('importPage.notes.filled', { field: label('importance'), v: c.t('importance.' + importance) });
      }
  
      // 期限（日付だけなら、その日の 23:59。空・読めないときは、取り込む日から決めた日数後）
      const dp = parseDate(get('due'));
      let dueAt: Date;
      if (dp) {
        dueAt = zonedTime(dp.y, dp.m, dp.d, dp.time ? dp.h : 23, dp.time ? dp.mi : 59, c.tz);
        if (dueAt.getTime() < c.nowMs) warn('importPage.notes.duePast');
      } else {
        const base = new Date(c.nowMs + c.defaults.dueDays * DAY);
        const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: c.tz }).format(base).split('-').map(Number);
        dueAt = zonedTime(y, m, d, 23, 59, c.tz);
        warn('importPage.notes.filled', { field: label('due'), v: `${y}/${m}/${d}` });
      }
  
      // 担当者（管理者・メンバーだけ。合わなければ取り込む人）
      const person = (f: 'assignee' | 'reporter') => {
        const v = get(f);
        const m = v ? memberByName.get(key(v)) : undefined;
        if (m && (f === 'reporter' || m.role !== 'viewer')) return m.uid;
        if (v) warn('importPage.notes.personUnknown', { field: label(f), v });
        return c.myUid;
      };
      const assigneeId = person('assignee');
      // 提起者：管理者だけ列で指定できる。メンバーは取り込んだ本人
      const reporterId = c.role === 'admin' ? person('reporter') : c.myUid;
  
      // ステータス：メンバーは未着手・対応中だけ。それ以外の行は最初は外す（入れれば未着手）
      const rawStatus = get('status');
      let status = STATUS_WORDS.get(key(rawStatus)) ?? 'open';
      if (rawStatus && !STATUS_WORDS.has(key(rawStatus))) warn('importPage.notes.statusUnknown', { v: rawStatus });
      if (c.role !== 'admin' && !ACTIVE_FOR_MEMBER.includes(status)) {
        notes.push({ level: 'skip', key: 'importPage.notes.statusMember', params: { v: c.t('status.' + status) } });
        status = 'open';
      }
  
      // 日時：管理者だけ。今より後は使わない
      const instant = (f: 'createdAt' | 'resolvedAt' | 'closedAt'): Date | null => {
        if (c.role !== 'admin') return null;
        const v = get(f);
        if (!v) return null;
        const p = parseDate(v);
        const d = p ? zonedTime(p.y, p.m, p.d, p.h, p.mi, c.tz) : null;
        if (!d || d.getTime() > c.nowMs) {
          warn('importPage.notes.dateUnusable', { field: label(f), v });
          return null;
        }
        return d;
      };
      const createdAt = instant('createdAt');
      const resolvedAt = status === 'resolved' || status === 'closed' ? instant('resolvedAt') : null;
      const closedAt = status === 'closed' ? instant('closedAt') : null;
  
      // ラベル（今あるものだけ。5個まで）
      const labelIds: string[] = [];
      for (const name of get('labels').split(/[,、;；/]/).map((s) => s.trim()).filter(Boolean)) {
        const l = labelByName.get(key(name));
        if (!l) warn('importPage.notes.labelUnknown', { v: name });
        else if (labelIds.length < 5 && !labelIds.includes(l.id)) labelIds.push(l.id);
      }
  
      // 発生日（日付だけ。今日より後は空にする）
      const op = parseDate(get('occurredOn'));
      let occurredOn = op ? `${op.y}-${pad(op.m)}-${pad(op.d)}` : null;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: c.tz }).format(new Date(c.nowMs));
      if (occurredOn && occurredOn > today) {
        occurredOn = null;
        warn('importPage.notes.occurredFuture');
      }
  
      let impact = get('impact');
      if (impact.length > 200) { impact = impact.slice(0, 200); warn('importPage.notes.truncated', { field: label('impact') }); }
  
      // 内容：元の番号を最後に足す（どの課題がどれだったか、あとで分かるように）
      const original = get('number');
      const description = [get('description'), original ? c.t('importPage.originalNumber', { n: original }) : '']
        .filter(Boolean).join('\n\n');
  
      // 重複：プロジェクトの課題、またはファイルの前の行と同じタイトル
      if (title && seen.has(key(title))) notes.push({ level: 'skip', key: 'importPage.notes.duplicate' });
      if (title) seen.add(key(title));
  
      const values: ImportValues = {
        title, type, importance, dueAt, assigneeId, reporterId,
        doneCriteria: get('doneCriteria') || c.t('doneCriteria.' + type),
        description, labelIds, occurredOn, impact, status, createdAt, resolvedAt, closedAt,
        cause: get('cause'), countermeasure: get('countermeasure'),
        causeCategory: CAUSE_WORDS.get(key(get('causeCategory'))) ?? null,
        effect: EFFECT_WORDS.get(key(get('effect'))) ?? null,
        learning: get('learning'),
      };
      return {
        line: idx + 2,
        include: !notes.some((n) => n.level !== 'warn'),
        values,
        notes,
      };
    });
  }
  
  /** 確認画面で選べる「空のときの値」の初期値 */
  export const DEFAULTS: ConvertContext['defaults'] = { type: 'task', importance: 'mid', dueDays: 7 };
  export { ISSUE_TYPES };