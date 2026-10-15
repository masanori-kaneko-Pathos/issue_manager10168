import { Issue, Label, labelsOf } from '../models';
import { priorityOf } from './priority';
import { dateKey, toLocalInput } from '../time/time';

/**
 * CSV の列
 */
export const CSV_COLUMNS = [
  'number', 'title', 'type', 'status', 'priority', 'importance', 'due', 'assignee', 'reporter', 'labels',
  'occurredOn', 'impact', 'doneCriteria', 'description', 'cause', 'countermeasure', 'causeCategory',
  'effect', 'learning', 'createdAt', 'updatedAt', 'resolvedAt', 'closedAt',
] as const;
type Column = (typeof CSV_COLUMNS)[number];

/** 書き出すときに使う、画面側の道具（翻訳・名前・ラベル・タイムゾーン・今の時刻） */
export interface CsvContext {
  t: (key: string) => string;
  nameOf: (uid: string) => string;
  labels: Label[];
  tz: string;
  nowMs: number;
}

/**
 * 1つの値を CSV のマスにする。
 * - 全体を " で囲み、中の " は "" にする（値の中のカンマ・改行も、これで1マスに収まる）
 * - = + - @ で始まる値は、頭に ' を付ける（Excel が式として動かしてしまうのを防ぐ。取り込みでは外す）
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** 日時を、見る人のタイムゾーンで「2026-10-14 18:00」にする */
function when(ts: { toDate(): Date } | undefined, tz: string): string {
  return ts ? toLocalInput(ts.toDate(), tz).replace('T', ' ') : '';
}

/** 課題の一覧を CSV の文字列にする（列の名前と値は、見る人の言語で） */
export function issuesToCsv(issues: Issue[], c: CsvContext): string {
  const isActive = (i: Issue) => i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  const header = CSV_COLUMNS.map((k) => c.t('csv.cols.' + k));
  const rows = issues.map((i) => {
    const v: Record<Column, string> = {
      number: String(i.number),
      title: i.title,
      type: c.t('issueTypes.' + i.type),
      status: c.t('status.' + i.status),
      // 優先度は、画面と同じく未完了のものだけ（終わった課題には出さない）
      priority: isActive(i) ? c.t('priority.' + priorityOf(i, c.nowMs)) : '',
      importance: c.t('importance.' + i.importance),
      due: when(i.dueAt, c.tz),
      assignee: c.nameOf(i.assigneeId),
      reporter: c.nameOf(i.reporterId),
      labels: labelsOf(i.labelIds, c.labels).map((l) => l.name).join(', '),
      occurredOn: i.occurredOn ?? '',
      impact: i.impact ?? '',
      doneCriteria: i.doneCriteria,
      description: i.description,
      cause: i.cause ?? '',
      countermeasure: i.countermeasure ?? '',
      causeCategory: i.causeCategory ? c.t('causeCategories.' + i.causeCategory) : '',
      effect: i.effect ? c.t('workflow.effectOpts.' + i.effect) : '',
      learning: i.learning ?? '',
      createdAt: when(i.createdAt, c.tz),
      updatedAt: when(i.updatedAt, c.tz),
      resolvedAt: when(i.resolvedAt, c.tz),
      closedAt: when(i.closedAt, c.tz),
    };
    return CSV_COLUMNS.map((k) => v[k]);
  });

  return '\uFEFF' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** 文字列を、ファイルとして保存させる */
export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** ファイル名「プロジェクト名_20261014.csv」（ファイル名に使えない文字 \ / : * ? " < > | は _ に） */
export function csvFileName(projectName: string | undefined, nowMs: number, tz: string): string {
    const name = (projectName || 'issues').replace(/[\\/:*?"<>|]/g, '_');
    return `${name}_${dateKey(new Date(nowMs), tz).replace(/-/g, '')}.csv`;
  }