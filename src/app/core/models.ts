import { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'member' | 'viewer';

export const LABEL_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'gray'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export interface Label { id: string; name: string; color?: LabelColor; }

export const MAX_LABELS_PER_ISSUE = 5;   // 1つの課題に付けられる数（仕様メモ）
export const MAX_LABELS_PER_PROJECT = 30; // 1つのプロジェクトで作れる数

/** 初期ラベルの色（色が未設定の古いプロジェクト用） */
const DEFAULT_LABEL_COLORS: Record<string, LabelColor> = {
  customer: 'blue', internal: 'green', spec: 'purple', ops: 'orange', quality: 'red',
};

export function labelColor(l: Label): LabelColor {
  return l.color ?? DEFAULT_LABEL_COLORS[l.id] ?? 'gray';
}

export interface ProjectSettings {
  notifyHour: number;        // 通知時刻（受け取る人の現地時間）
  staleDays: number;         // 停滞とみなす日数
  effectCheckDays: number;   // 解決済みから効果確認までの日数
  highPriorityLimit: number; // ダッシュボードで注意を出す高優先度の件数
  features: { effort: boolean; gantt: boolean; recurring: boolean };
}

export interface Project {
  id: string;
  name: string;
  archived: boolean;
  createdBy: string;
  createdAt: Timestamp;
  labels: Label[];
  settings: ProjectSettings;
  issueSeq: number;          // 課題番号の連番
}

export interface ProjectWithRole extends Project { role: Role; }

export interface Member {
  uid: string;
  role: Role;
  displayName: string;
  photoURL: string | null;
  joinedAt: Timestamp;
}

export interface Invitation {
  projectId: string;
  email: string;          // 小文字にそろえる。文書IDも同じ
  role: Role;
  projectName: string;    // 招待された人は、参加前はプロジェクトを読めないので写しを持つ
  invitedBy: string;
  invitedByName: string;
  createdAt: Timestamp;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  notifyHour: 10, staleDays: 7, effectCheckDays: 7, highPriorityLimit: 10,
  features: { effort: false, gantt: false, recurring: false },
};

export const DEFAULT_LABEL_IDS = ['customer', 'internal', 'spec', 'ops', 'quality'] as const;

export type IssueType = 'bug' | 'request' | 'question' | 'task' | 'risk';
export type Level = 'high' | 'mid' | 'low'; // 重要度・緊急度・優先度で共通
export type IssueStatus = 'open' | 'in_progress' | 'on_hold' | 'resolved' | 'closed' | 'rejected';

export const ISSUE_TYPES: IssueType[] = ['bug', 'request', 'question', 'task', 'risk'];
export const OPEN_STATUSES: IssueStatus[] = ['open', 'in_progress', 'on_hold', 'resolved'];

export interface Issue {
  id: string;
  number: number;
  title: string;
  type: IssueType;
  status: IssueStatus;
  importance: Level;
  priorityOverride: Level | null; // 人が優先度を変えたときだけ入る
  dueAt: Timestamp;
  startAt: Timestamp;
  doneCriteria: string;
  description: string;
  assigneeId: string;
  reporterId: string;
  labelIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  statusReason?: string;      // 直近の保留・却下などの理由
  cause?: string;
  countermeasure?: string;
  causeCategory?: CauseCategory;
  doneCriteriaMet?: boolean;
  effect?: Effect;
  learning?: string;
  resolvedAt?: Timestamp;
  closedAt?: Timestamp;
}
export const CAUSE_CATEGORIES = [
  'requirements', 'design', 'testing', 'operation', 'communication', 'external', 'other',
] as const;
export type CauseCategory = (typeof CAUSE_CATEGORIES)[number];
export type Effect = 'yes' | 'partial' | 'no';

/** 経緯（履歴とコメントを時系列に並べたもの） */
export interface TimelineItem {
  id: string;
  kind: 'event' | 'comment';
  type?: 'created' | 'status' | 'edit' | 'priority';
  fields?: string[];  // 編集した項目
  changes?: {
    dueAt?: { from: Timestamp; to: Timestamp };
    assigneeId?: { from: string; to: string };
    doneCriteria?: { from: string; to: string };
  };
  fromPriority?: Level | null; // null は「自動」
  toPriority?: Level | null;
  autoPriority?: Level;        // 変更した時点の自動の値
  from?: IssueStatus;
  to?: IssueStatus;
  reason?: string;
  body?: string;
  by: string;
  tz?: string;  // 書いた人のタイムゾーン
  at: Timestamp;
}