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
  sample?: boolean;             // 見本のプロジェクト（イントロダクションで作ったもの）
  description?: string;         // 概要の説明（何のためのプロジェクトか・いつまで・決まりごと）。書くのは管理者
}

/** joinedAt：自分が参加した日時（並べていないプロジェクトを、新しい順に並べるため） */
export interface ProjectWithRole extends Project { role: Role; joinedAt?: Timestamp; }

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
  pinned?: boolean;         // ピン止め（上に並ぶ。吹き出し・ホーム・受信箱のページで同じ）
}

/** 管理ログ（今は書くだけ。見る画面は後日） */
export interface AdminLog {
  type: 'role' | 'remove' | 'leave' | 'handover' | 'import' | 'archive' | 'unarchive' | 'account';
  by: string;           // 操作した人
  target: string;       // 対象の人
  from: Role;           // 操作する前の役割
  to: Role | null;      // 役割を変えたときの、変えた先
  moved: number;        // 引き継いだ課題の数
  at: Timestamp;
}

/** 毎朝のまとめの形（due＝期限別、priority＝優先度別、assignee＝担当者別） */
export type DailyGroup = 'due' | 'priority' | 'assignee';
export const DAILY_GROUPS: DailyGroup[] = ['due', 'priority', 'assignee'];
/**
 * メールで受け取る通知のまとまり（初期はどれもオフ）。
 * ※ functions/src/index.ts の EMAIL_GROUP_OF の値と、ルールの emailNotify の一覧と同じにすること
 */
export const EMAIL_GROUPS = ['daily', 'assign', 'comment', 'status', 'request', 'reminder'] as const;
export type EmailGroup = typeof EMAIL_GROUPS[number];
/** プロジェクトごとの朝の通知の時刻。0時からの分（0〜1430、10分刻み）か、'off'（受け取らない） */
export type DailyTime = number | 'off';
/** 決めていないプロジェクトの時刻（10:00） */
export const DEFAULT_DAILY_TIME = 600;
/** 時刻の刻み（分）。関数は、この間隔で起きる */
export const DAILY_TIME_STEP = 10;

/** 正しい時刻か（0〜1430 の10の倍数か 'off'）。ルールで中を確かめられないので、読むときにここで確かめる */
export function validDailyTime(v: unknown): DailyTime | null {
  if (v === 'off') return 'off';
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 24 * 60 && v % DAILY_TIME_STEP === 0 ? v : null;
}

/** 通知の種類 */
export type NotificationType =
  'assigned' | 'comment' | 'dueChanged' | 'resolved' | 'sentBack' | 'closed' | 'rejected' | 'restored' | 'joined'
  | 'handover' | 'daily' | 'effectCheck' | 'unblocked' | 'merged' | 'projectDeleted' | 'subtaskAssigned'
  | 'mention' | 'watchResolved' | 'request' | 'requestDone' | 'requestDeclined' | 'reminder' | 'subtaskReminder'
  | 'recurring' | 'recurringStopped';

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
  /** 朝のまとめ（daily）の件数。関数だけが書く。どの数が入るかは group で決まる（0件の区分は入らない） */
  counts?: Record<string, number>;
  /** 朝のまとめの形（送った時点の形）。古いお知らせには無い（＝期限別） */
  group?: DailyGroup;
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
  watchers?: string[];        // 自分でウォッチを付けた人（提起者・担当者は自動なので、ここには入れない）
  muted?: string[];           // 自動のウォッチ（提起者・担当者）を、自分で外した人
  estimateHours?: number | null; // 工数の見積（時間）。工数がオンのプロジェクトだけ
  actualHours?: number | null;   // 工数の実績（時間）
  recurringId?: string;          // 定期課題から作られたとき、その雛形
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
  type?: 'created' | 'imported' | 'status' | 'edit' | 'priority' | 'link' | 'merge' | 'subtask' | 'attachment'
    | 'recurring';
  /** 課題に添付した・消した（type が attachment のときだけ。コメントへの添付は残さない＝コメントそのものが残るため） */
  file?: { action: 'add' | 'remove'; name: string };
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
  mentions?: string[];    // コメントでメンションした人（uid）。本文の「@名前」は見た目だけ
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

/**
 * 実際にウォッチしている人：提起者・担当者（自動）＋ 自分で付けた人 − 自動を外した人（赤T）。
 * 保存はしない（登録・取り込み・担当の変更のたびに書き直さずに済むように、毎回ここで計算する）
 */
export function watchersOf(i: Pick<Issue, 'reporterId' | 'assigneeId' | 'watchers' | 'muted'>): string[] {
  const muted = new Set(i.muted ?? []);
  return [...new Set([i.reporterId, i.assigneeId, ...(i.watchers ?? [])])].filter((u) => !!u && !muted.has(u));
}

/** 自動でウォッチされる人か（提起者・担当者） */
export function isAutoWatcher(i: Pick<Issue, 'reporterId' | 'assigneeId'>, uid: string): boolean {
  return i.reporterId === uid || i.assigneeId === uid;
}

/** 依頼の種類（メンバーが管理者に頼める、管理者だけの操作） */
export type RequestKind = 'delete' | 'merge' | 'reopen';
/** open＝対応待ち、done＝対応済み、declined＝見送り、cancelled＝取り下げ */
export type RequestStatus = 'open' | 'done' | 'declined' | 'cancelled';

/**
 * 依頼（projects/{pid}/requests）。課題の番号と題名は写しを持つ（一覧で課題を読み直さずに出すため）。
 * 消さずに残す（だれが・いつ・何を頼み、どうなったかの記録）
 */
export interface IssueRequest {
  id: string;
  kind: RequestKind;
  iid: string;
  number: number;
  title: string;
  targetIid: string | null;     // 統合のときの統合先
  targetNumber: number | null;
  reason: string;
  by: string;
  byName: string;
  at: Timestamp;
  status: RequestStatus;
  handledBy?: string;
  handledAt?: Timestamp;
  note?: string;                // 見送るときの一言（任意）
}

/**
 * リマインド（users/{uid}/reminders/{rid}）。本人だけが読み書きする。
 * 文書の名前：課題は「pid_iid」、サブタスクは「pid_iid_sid」（1つに1つ）、自由入力は自動の名前（_ を含まない）。
 * 届けても消さない（pending を false にして firedAt を書く）。完了にすると30日後に自動で消える（TTL）
 */
export interface Reminder {
  id: string;
  pid?: string;          // 課題・サブタスクのときだけ（自由入力には無い）
  iid?: string;          // 課題・サブタスクのときだけ
  number?: number;       // 写し（課題・サブタスクのときだけ）
  title: string;         // 課題・サブタスクは課題名の写し、自由入力は本文（200字まで）
  projectName?: string;  // 写し（課題・サブタスクのときだけ）
  sid?: string;          // サブタスクのときだけ
  subTitle?: string;     // サブタスク名の写し（サブタスクのときだけ）
  at: Timestamp;         // 届ける時刻
  createdAt: Timestamp;
  pending: boolean;      // まだ届けていない（関数は true のものだけ探す）
  firedAt?: Timestamp;   // 届けた時刻（関数が書く）
  doneAt?: Timestamp;    // 完了にした時刻
  expireAt?: Timestamp;  // この日時を過ぎると Firestore が自動で消す（完了にしたものだけ）
}
/** 完了にしたリマインドを残す日数 */
export const REMINDER_KEEP_DAYS = 30;
/** 自由入力のリマインドの数（ルールでは数えられないので、画面で止める） */
export const MAX_FREE_REMINDERS = 100;

/** 保存した絞り込み（users/{uid}/filters）。query は URL の ? より後ろの文字列 */
export interface SavedFilter {
  id: string;
  name: string;
  pid: string;
  query: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** 添付（projects/{pid}/issues/{iid}/attachments）。ファイル本体は Storage の path に置く */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;      // ファイルの種類（image/png など）
  path: string;      // Storage の置き場所
  cid?: string;      // コメントへの添付のときだけ
  by: string;
  at: Timestamp;
}
/** 1つの課題に添付できる数・1ファイルの大きさ（ルールでは数えられないので、数は画面で止める） */
export const MAX_ATTACHMENTS = 10;
/** プロジェクトの概要に添付できる数（資料が多めなので、課題より多く） */
export const MAX_PROJECT_FILES = 20;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 定期課題の繰り返し方（daily＝毎日、weekly＝毎週、monthly＝毎月） */
export type RecurFreq = 'daily' | 'weekly' | 'monthly';

/** いつ作るか（画面と関数で、同じ計算に渡す形） */
export interface RecurSpec {
  freq: RecurFreq;
  weekdays: number[];   // 毎週のときの曜日（0＝日〜6＝土）
  monthDay: number;     // 毎月のときの日にち（1〜28、31＝月末）
  time: number;         // 作る時刻。0時からの分（10分刻み）
  tz: string;           // 時刻を数えるタイムゾーン（作った管理者のもの）
}

/** 定期課題の雛形（projects/{pid}/recurring/{rid}）。作る・直すのは管理者だけ。課題を作るのは関数 */
export interface RecurringTemplate extends RecurSpec {
  id: string;
  title: string;
  type: IssueType;
  importance: Level;
  assigneeId: string;
  doneCriteria: string;
  description: string;
  labelIds: string[];
  dueDays: number;               // 期限：作った日の何日後の 23:59 か（0・1・3・7）
  active: boolean;
  stopped?: 'member';            // 担当者か作った人が担当できなくなって、関数が止めた
  nextAt: Timestamp;             // 次に作る時刻
  lastAt?: Timestamp;
  lastNumber?: number;           // 前回作った課題の番号
  createdBy: string;             // 作った管理者（作られる課題の提起者になる）
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
/** 1つのプロジェクトで作れる定期課題の数（ルールでは数えられないので、画面で止める） */
export const MAX_RECURRING = 20;
export const RECUR_DUE_DAYS = [0, 1, 3, 7];

/**
 * プロジェクトの動きの帳面の1行（projects/{pid}/activity）。経緯・コメントができると、関数が写す。30日で消える
 */
export interface Activity {
  id: string;
  kind: 'event' | 'comment';
  iid: string;
  number: number | null;   // 写したときの課題の番号
  title: string;           // 写したときの課題の題名
  type?: TimelineItem['type'];
  from?: IssueStatus;
  to?: IssueStatus;
  fields?: string[];
  link?: TimelineItem['link'];
  sub?: TimelineItem['sub'];
  file?: TimelineItem['file'];
  merged?: TimelineItem['merged'];
  body?: string;           // コメントの書き出し
  by: string;
  at: Timestamp;
}

/** 工数の入力を、0.5刻みの時間にそろえる。空なら null、数でない・範囲の外なら undefined（保存しない） */
export function toHours(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 999) return undefined;
  return Math.round(n * 2) / 2;
}