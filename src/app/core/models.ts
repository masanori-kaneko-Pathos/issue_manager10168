import { Timestamp } from 'firebase/firestore';

export type Role = 'admin' | 'member' | 'viewer';

export const LABEL_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'gray'] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export interface Label { id: string; name: string; color?: LabelColor; }

export const MAX_LABELS_PER_ISSUE = 5;   // 1つの課題に付けられる数
export const MAX_LABELS_PER_PROJECT = 30; // 1つのプロジェクトで作れる数

/** 初期ラベルの色（色が未設定の古いプロジェクト用） */
const DEFAULT_LABEL_COLORS: Record<string, LabelColor> = {
  customer: 'blue', internal: 'green', spec: 'purple', ops: 'orange', quality: 'red',
};

export function labelColor(l: Label): LabelColor {
  return l.color ?? DEFAULT_LABEL_COLORS[l.id] ?? 'gray';
}

/** アーカイブの種類（completed＝完了、cancelled＝打ち切り） */
export type ArchiveKind = 'completed' | 'cancelled';

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
  formerMembers?: Record<string, string>; // 外した・抜けた人の表示名（uid → 名前）
  archiveKind?: ArchiveKind;    // アーカイブ中だけ
  archiveReason?: string;
  archivedAt?: Timestamp;
  archivedBy?: string;
  deleting?: boolean;           // 削除の最中（関数が最初に立てる。開いている画面はこれを見てホームへ戻る）
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

/** 受信箱のメモ（本人にしか見えない。課題にするまで、期限・通知・集計の対象外） */
export interface InboxMemo {
  id: string;
  title: string;
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  discardedAt?: Timestamp;  // ゴミ箱に入れた日時（ゴミ箱の中だけ）
  expireAt?: Timestamp;     // この日時を過ぎると、Firestore が自動で消す（TTL。ゴミ箱の中だけ）
}

/** 管理ログ（今は書くだけ。見る画面は後日） */
export interface AdminLog {
  type: 'role' | 'remove' | 'leave' | 'handover' | 'import' | 'archive' | 'unarchive';
  by: string;           // 操作した人
  target: string;       // 対象の人
  from: Role;           // 操作する前の役割
  to: Role | null;      // 役割を変えたときの、変えた先
  moved: number;        // 引き継いだ課題の数
  at: Timestamp;
}

/** 通知の種類 */
export type NotificationType =
  'assigned' | 'comment' | 'dueChanged' | 'resolved' | 'sentBack' | 'closed' | 'rejected' | 'restored' | 'joined'
  | 'handover' | 'daily' | 'effectCheck' | 'unblocked' | 'merged' | 'projectDeleted' | 'subtaskAssigned';

/**
 * 画面内の通知（users/{uid}/notifications）。本人だけが読める。
 * 一覧で他の文書を読まずに出せるよう、プロジェクト名・課題の番号とタイトル・送った人の名前の写しを持つ
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  pid: string;
  projectName: string;
  iid: string | null;          // 招待の承諾（joined）は課題がないので null
  issueNumber: number | null;  // 引き継ぎ（handover）のときは、引き継いだ件数
  issueTitle: string;          // 課題がないときは ''
  by: string;                  // 送った人の uid
  byName: string;
  detail: string;              // コメントの書き出しなど。なければ ''
  at: Timestamp;
  read: boolean;
  pinned?: boolean;            // ピン止め（上に固定し、自動では消さない）
  expireAt?: Timestamp;        // この日時を過ぎると、Firestore が自動で消す（TTL）。ピン止め中は無い
  /** 朝のまとめ（daily）の件数。関数だけが書く */
  counts?: { overdue: number; today: number; tomorrow: number; in3: number; inboxOld: number };
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  notifyHour: 10, staleDays: 7, effectCheckDays: 7, highPriorityLimit: 10,
  features: { effort: false, gantt: false, recurring: false },
};

export const DEFAULT_LABEL_IDS = ['customer', 'internal', 'spec', 'ops', 'quality'] as const;

export type IssueType = 'bug' | 'request' | 'question' | 'task' | 'risk';
export type Level = 'high' | 'mid' | 'low'; // 重要度・緊急度・優先度で共通
export type IssueStatus =
  'open' | 'in_progress' | 'on_hold' | 'resolved' | 'closed' | 'rejected' | 'deleted' | 'merged';

export const ISSUE_TYPES: IssueType[] = ['bug', 'request', 'question', 'task', 'risk'];
export const OPEN_STATUSES: IssueStatus[] = ['open', 'in_progress', 'on_hold', 'resolved'];

/** 課題どうしのひも付け（今は再発防止だけ。提出2の関連課題でも、kind を増やして同じ形を使う） */
export interface IssueLink {
  kind: 'prevention';
  iid: string;     // 元の課題
  number: number;  // 元の課題の番号（表示用の写し）
}

/** 関連課題の種類（relates＝ただの関連、recurrence＝再発、duplicate＝重複、waitsFor＝完了待ち） */
export type LinkKind = 'relates' | 'recurrence' | 'duplicate' | 'waitsFor';
export const LINK_KINDS: LinkKind[] = ['relates', 'recurrence', 'duplicate', 'waitsFor'];

/**
 * 関連課題（projects/{pid}/issues/{iid}/links）。両側に1枚ずつ置く。
 * out＝この課題から付けた、in＝相手から付けられた（相手側の写し）。相手の題名や番号は写さない
 */
export interface IssueRelation {
  id: string;
  kind: LinkKind;
  dir: 'out' | 'in';
  pid: string;  // 相手の課題のプロジェクト
  iid: string;  // 相手の課題
  by: string;
  at: Timestamp;
}

/** 関連課題の文書の名前。「種類・向き・相手」で決めるので、同じひも付けは2つ作れない */
export function relationId(kind: LinkKind, dir: 'out' | 'in', pid: string, iid: string) {
  return `${kind}_${dir}_${pid}_${iid}`;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  type: IssueType;
  status: IssueStatus;
  importance: Level;
  priorityOverride: Level | null; // 人が優先度を変えたときだけ入る
  dueAt: Timestamp;
  firstDueAt?: Timestamp;     // 登録したときの期限（期限遵守率に使う。古い課題にはない）
  startAt: Timestamp;
  doneCriteria: string;
  description: string;
  assigneeId: string;
  reporterId: string;
  labelIds: string[];
  occurredOn?: string | null; // 発生日（'YYYY-MM-DD'。書いた人の暦の日付。時刻は持たない）。任意
  impact?: string;            // 影響範囲（自由に1行）。任意
  createdAt: Timestamp;
  updatedAt: Timestamp;
  updatedBy?: string;         // 最後に書き込んだ人の uid
  statusReason?: string;      // 直近の保留・却下などの理由
  cause?: string;
  countermeasure?: string;
  causeCategory?: CauseCategory;
  doneCriteriaMet?: boolean;
  effect?: Effect;
  learning?: string;
  workaround?: string;          // 回避策（暫定対応）
  workaroundEnded?: boolean;    // 解決済みにするときに「回避策は外した」と確かめた
  resolvedAt?: Timestamp;
  resolvedAssignee?: string;  // 解決済みにした時点の担当者（実績の記録。あとで担当を替えても変わらない）  
  closedAt?: Timestamp;
  deletedFrom?: IssueStatus;  // 削除する前のステータス（復元で戻す）
  deletedReason?: string;
  deletedAt?: Timestamp;
  deletedBy?: string;
  relatedFrom?: IssueLink;    // この課題が、どの課題から作られたか（再発防止など）
  importId?: string;          // 取り込みの1回ごとの印（まとめて取り消すときに使う）
  importedBy?: string;        // 取り込んだ人
  mergedInto?: { iid: string; number: number }; // 統合済みのとき、統合先の課題
  subtaskTotal?: number;      // サブタスクの数（切り出したものは除く）。関数だけが書く
  subtaskDone?: number;       // そのうち完了の数。関数だけが書く
  subtaskAssignees?: string[]; // 未完了のサブタスクの担当者（ホームの見張り用）。関数だけが書く
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
  type?: 'created' | 'imported' | 'status' | 'edit' | 'priority' | 'link' | 'merge' | 'subtask';
  /** サブタスクを足した・消した・切り出した（type が subtask のときだけ。状態の切り替えは残さない） */
  sub?: { action: 'add' | 'remove' | 'split'; title: string; number?: number };
  /** 統合先の経緯に残す「どの課題を統合したか」（type が merge のときだけ） */
  merged?: { iid: string; number: number };
  /** 関連課題を付けた・外した（type が link のときだけ） */
  link?: { action: 'add' | 'remove'; kind: LinkKind; dir: 'out' | 'in'; pid: string; iid: string; number: number | null };
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
  editedAt?: Timestamp;   // コメントを直した日時
  deleted?: boolean;      // コメントを消した印（論理削除）
  deletedBy?: string;
  deletedAt?: Timestamp;
  at: Timestamp;
}

/** 課題の labelIds から、表示するラベルを取り出す。
 *  並びはプロジェクトのラベル一覧の順。削除されたラベルの id は無視する */
export function labelsOf(ids: string[] | undefined, all: Label[]): Label[] {
  const set = new Set(ids ?? []);
  return all.filter((l) => set.has(l.id));
}

/** サブタスクの状態（todo＝未着手、doing＝対応中、done＝完了）。課題のステータスより軽く、理由は要らない */
export type SubtaskStatus = 'todo' | 'doing' | 'done';
/** 1つの課題に付けられるサブタスクの数（ルールでは数えられないので、画面で止める） */
export const MAX_SUBTASKS = 30;

/** サブタスク（projects/{pid}/issues/{iid}/subtasks）。1段階だけ */
export interface Subtask {
  id: string;
  title: string;
  assigneeId: string;
  dueAt: Timestamp | null;     // 任意。親の期限より後にはできない（足したとき・変えたときだけ確かめる）
  status: SubtaskStatus;
  memo: string;
  order: number;               // 並び順。間に入れるときは、前後の真ん中の数にする
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  updatedBy: string;
  splitTo?: { iid: string; number: number }; // 課題に切り出したときだけ。進捗率から外れる
}

/** 「回避策適用中」の印を出すか：未完了で、回避策が書いてあり、まだ外していない */
export function hasWorkaround(i: Issue): boolean {
  return !!i.workaround?.trim() && !i.workaroundEnded
    && (i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold');
}