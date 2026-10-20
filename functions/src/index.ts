import { initializeApp } from 'firebase-admin/app';
import { DocumentData, DocumentReference, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';
import { onDocumentCreated, onDocumentDeleted, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

initializeApp();
/** 課題管理アプリのデータベース。名前を指定しないと (default) を読んでしまう */
const db = getFirestore('issuemanager');
/** 添付のファイルを置くバケット（US-CENTRAL1。無料の枠がある場所） */
const BUCKET = 'kensyu10168.firebasestorage.app';

const DAY = 24 * 60 * 60 * 1000;
/** 通知が自動で消えるまでの日数（アプリ側の NOTIFY_KEEP_DAYS と同じ） */
const NOTIFY_KEEP_DAYS = 90;
/** 受信箱のメモが「古い」とされる日数（アプリ側の INBOX_OLD_DAYS と同じ） */
const INBOX_OLD_DAYS = 7;
/** 未完了のステータス（まとめで数えるもの。削除・クローズ・却下・解決済みは数えない） */
const ACTIVE = ['open', 'in_progress', 'on_hold'];
const DEFAULT_TZ = 'Asia/Tokyo';
/** 毎朝のまとめの時刻の初期値（0時からの分。アプリの DEFAULT_DAILY_TIME と同じ） */
const DEFAULT_DAILY_TIME = 600;
const DEFAULT_REMINDERS = ['today', 'tomorrow', 'in3'];
const DEFAULT_EFFECT_DAYS = 7;

type Bucket = 'overdue' | 'today' | 'tomorrow' | 'in3';

type Level = 'high' | 'mid' | 'low';
/** 毎朝のまとめの形（due＝期限別、priority＝優先度別、assignee＝担当者別） */
type DailyGroup = 'due' | 'priority' | 'assignee';

/** 保存されている形を読む。ない・知らない値なら期限別（今までの形） */
function dailyGroupOf(v: unknown): DailyGroup {
  return v === 'priority' || v === 'assignee' ? v : 'due';
}

/** 0〜1430 の10の倍数なら、その時刻。違えば null（ルールでも確かめているが、古いデータに備える） */
function validTime(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1440 && v % 10 === 0 ? v : null;
}

// ---- 時刻の道具（アプリの time.ts と同じ決まり） ----

/** 瞬間を、timeZone での日付（YYYY-MM-DD）にする */
function dateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}

/**
 * 瞬間の、timeZone での時刻を、0時からの分で、10分刻みに切り下げたもの（例：9:07 → 540）。
 * 関数は10分ごとに起きるので、起きるのが少し遅れても、同じ枠に入る
 */
function slotIn(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + Math.floor(m / 10) * 10;
}

/** 'YYYY-MM-DD' どうしの日数の差 */
function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((Date.parse(toKey + 'T00:00:00Z') - Date.parse(fromKey + 'T00:00:00Z')) / DAY);
}

/**
 * 期限の区分。日数は、受け取る人のタイムゾーンの暦で数える。3日より先は null。
 * ※ src/app/core/time/time.ts の dueBucket と同じ決まりにすること（片方を変えたら、もう片方も変える）
 */
function dueBucket(dueMs: number, nowMs: number, tz: string): Bucket | null {
  if (dueMs < nowMs) return 'overdue';
  const days = daysBetween(dateKey(new Date(nowMs), tz), dateKey(new Date(dueMs), tz));
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 3) return 'in3';
  return null;
}

/** タイムゾーンの名前が正しくなければ、既定に戻す（正しくない名前だと Intl がエラーを出すため） */
function safeTz(tz: unknown): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz);
  } catch {
    return DEFAULT_TZ;
  }
}

// ---- 優先度 ----
// ※ src/app/core/issue/priority.ts の urgencyOf・priorityOf と同じ決まりにすること（片方を変えたら、もう片方も変える）

const HOUR = 60 * 60 * 1000;

/** 緊急度：期限までの残り時間から決める */
function urgencyOf(dueMs: number, nowMs: number): Level {
  const left = dueMs - nowMs;
  if (left <= 24 * HOUR) return 'high'; // 24時間以内、または期限切れ
  if (left <= 72 * HOUR) return 'mid';  // 3日以内
  return 'low';
}

/** [重要度][緊急度] → 優先度 */
const PRIORITY_TABLE: Record<Level, Record<Level, Level>> = {
  high: { high: 'high', mid: 'high', low: 'mid' },
  mid:  { high: 'high', mid: 'mid',  low: 'low' },
  low:  { high: 'mid',  mid: 'low',  low: 'low' },
};

/** 優先度：手動で変えていればその値、なければ重要度と緊急度から */
function priorityOf(i: DocumentData, nowMs: number): Level {
  if (i.priorityOverride) return i.priorityOverride as Level;
  const imp = (PRIORITY_TABLE[i.importance as Level] ? i.importance : 'mid') as Level;
  return PRIORITY_TABLE[imp][urgencyOf(i.dueAt.toMillis(), nowMs)];
}

// ---- 朝のまとめ ----

interface Target {
  uid: string;
  tz: string;
  reminders: string[];   // 期限前の通知で数える区分
  group: DailyGroup;     // まとめの形
  pids: string[];        // その人が所属する、アーカイブ中でないプロジェクト（全部まとめて1通）
}

/**
 * 朝のまとめ：今、現地時間が本人の決めた時刻になった人に、全プロジェクト分を1日1通書く。
 * Functions はルールを通らないので、「アーカイブ中は飛ばす」「未完了だけ数える」「メンバーにだけ送る」を、ここで確かめる
 */
async function sendMorningSummaries(now: Date) {
  // ① アーカイブ中でないプロジェクト
  const projects = new Map((await db.collection('projects').where('archived', '==', false).get())
    .docs.map((p) => [p.id, p.data()]));
  if (!projects.size) return;

  // ② メンバー（全プロジェクト分を1回で読む）→ 人ごとの所属プロジェクトと、プロジェクトごとのメンバー
  const projectsOf = new Map<string, string[]>();
  const membersOf = new Map<string, { uid: string; role: string }[]>();
  for (const m of (await db.collectionGroup('members').get()).docs) {
    const pid = m.ref.parent.parent?.id;
    if (!pid || !projects.has(pid)) continue;
    projectsOf.set(m.id, [...(projectsOf.get(m.id) ?? []), pid]);
    membersOf.set(pid, [...(membersOf.get(pid) ?? []), { uid: m.id, role: m.get('role') }]);
  }
  if (!projectsOf.size) return;

  // ③ 今が通知時刻の人を探す（タイムゾーンと期限前の選択は users から）
  const users = await db.getAll(...[...projectsOf.keys()].map((uid) => db.doc(`users/${uid}`)));
  const targets: Target[] = [];
  for (const u of users) {
    if (!u.exists) continue;
    const tz = safeTz(u.get('timeZone'));
    // 本人が決めた時刻（10分刻み）になった人だけ
    if ((validTime(u.get('dailyTime')) ?? DEFAULT_DAILY_TIME) !== slotIn(now, tz)) continue;
    targets.push({
      uid: u.id, tz, reminders: u.get('dueReminders') ?? DEFAULT_REMINDERS,
      group: dailyGroupOf(u.get('dailyGroup')), pids: projectsOf.get(u.id) ?? [],
    });
  }
  if (!targets.length) return;

  // ④ 今その時刻の人がいるプロジェクトだけ、未完了の課題を読む（プロジェクトごとに1回）
  const openByPid = new Map<string, DocumentData[]>();
  await Promise.all([...new Set(targets.flatMap((t) => t.pids))].map(async (pid) => {
    const s = await db.collection(`projects/${pid}/issues`).where('status', 'in', ACTIVE).get();
    openByPid.set(pid, s.docs.map((d) => d.data()));
  }));

  // ⑤ 人ごとに数えて、1通書く（1人の失敗で、ほかの人の分を止めない）
  let written = 0;
  for (const t of targets) {
    try {
      if (await writeSummary(t, openByPid, now)) written++;
    } catch (e) {
      logger.error('morning summary failed', { uid: t.uid, error: String(e) });
    }
  }
  logger.info('morning summaries', { targets: targets.length, written });

  // ⑥ 効果確認（解決済みにしてから、決まった日数がたった課題）
  await sendEffectChecks(targets, projects, membersOf, now);
}

/** 1人分のまとめを数えて書く。書いたら true（何もない・もう書いてあるなら false） */
async function writeSummary(t: Target, openByPid: Map<string, DocumentData[]>, now: Date): Promise<boolean> {
  // 形ごとに、入る数が違う（0件の区分は入れない）
  const counts: Record<string, number> = {};
  const add = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  const nowMs = now.getTime();
  if (t.group === 'assignee') {
    // 担当者別：時刻になったプロジェクト全体の未完了が、何人に散っているか（名前と件数は並べない＝ランキングにしない）
    const people = new Set<string>();
    const late = new Set<string>();
    for (const pid of t.pids) {
      for (const i of openByPid.get(pid) ?? []) {
        if (!i.assigneeId || !i.dueAt) continue;
        add('active');
        people.add(i.assigneeId);
        if (i.dueAt.toMillis() < nowMs) {
          add('overdueAll');
          late.add(i.assigneeId);
        }
      }
    }
    if (counts.active) counts.people = people.size;
    if (counts.overdueAll) counts.overduePeople = late.size;
  } else {
    for (const pid of t.pids) {
      for (const i of openByPid.get(pid) ?? []) {
        if (i.assigneeId !== t.uid || !i.dueAt) continue;
        if (t.group === 'priority') {
          // 優先度別：自分の未完了すべて
          add(priorityOf(i, nowMs));
        } else {
          // 期限別：期限切れはいつも数える。期限前は、その人が選んだ区分だけ
          const b = dueBucket(i.dueAt.toMillis(), nowMs, t.tz);
          if (b && (b === 'overdue' || t.reminders.includes(b))) add(b);
        }
      }
    }
  }
  // 受信箱：7日以上たった、ゴミ箱に入れていないメモ（どの形でも付ける）
  const old = await db.collection(`users/${t.uid}/inbox`)
    .where('createdAt', '<=', Timestamp.fromMillis(nowMs - INBOX_OLD_DAYS * DAY)).get();
  const oldN = old.docs.filter((d) => !d.get('discardedAt')).length;
  if (oldN) counts.inboxOld = oldN;

  // 何もなければ送らない（「0件です」の通知は雑音になる）
  if (!Object.values(counts).some((n) => n > 0)) return false;

  // 文書IDを「日付」で決める → 1日1通。同じ日に2回動いても（時刻を変えた日も）、2回目は「もうある」で止まる
  const ref = db.doc(`users/${t.uid}/notifications/daily-${dateKey(now, t.tz)}`);
  try {
    await ref.create({
      type: 'daily', pid: '', projectName: '', iid: null, issueNumber: null, issueTitle: '',
      by: '', byName: '', detail: '', counts, group: t.group,
      at: FieldValue.serverTimestamp(), read: false,
      expireAt: Timestamp.fromMillis(now.getTime() + NOTIFY_KEEP_DAYS * DAY),
    });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS：この時刻の分はもう書いてある
    throw e;
  }
}

/**
 * 効果確認：解決済みにした日（受け取る人の暦）から effectCheckDays 日以上たった課題を、提起者に知らせる。
 * 提起者が抜けていたら、そのプロジェクトの管理者に知らせる（仕様メモ【9】「不在の場合は管理者」）
 */
async function sendEffectChecks(
  targets: Target[], projects: Map<string, DocumentData>,
  membersOf: Map<string, { uid: string; role: string }[]>, now: Date,
) {
  const targetOf = new Map(targets.map((t) => [t.uid, t]));
  let written = 0;
  for (const pid of new Set(targets.flatMap((t) => t.pids))) {
    const project = projects.get(pid);
    if (!project) continue;
    const days = project.settings?.effectCheckDays ?? DEFAULT_EFFECT_DAYS;
    const members = membersOf.get(pid) ?? [];
    const admins = members.filter((m) => m.role === 'admin').map((m) => m.uid);
    const resolved = await db.collection(`projects/${pid}/issues`).where('status', '==', 'resolved').get();
    for (const d of resolved.docs) {
      const i = d.data();
      if (!i.resolvedAt) continue;
      const to: string[] = members.some((m) => m.uid === i.reporterId) ? [i.reporterId] : admins;
      for (const uid of to) {
        const t = targetOf.get(uid);
        // 今が、その人の毎朝のまとめの時刻のときだけ
        if (!t || !t.pids.includes(pid)) continue;
        const resolvedDay = dateKey(i.resolvedAt.toDate(), t.tz);
        if (daysBetween(resolvedDay, dateKey(now, t.tz)) < days) continue;
        try {
          // 解決した日をIDに入れる：差し戻して、もう一度解決したときは、改めて知らせるため
          await db.doc(`users/${uid}/notifications/effect-${d.id}-${resolvedDay}`).create({
            type: 'effectCheck', pid, projectName: project.name ?? '', iid: d.id,
            issueNumber: i.number ?? null, issueTitle: i.title ?? '',
            by: '', byName: '', detail: '',
            at: FieldValue.serverTimestamp(), read: false,
            expireAt: Timestamp.fromMillis(now.getTime() + NOTIFY_KEEP_DAYS * DAY),
          });
          written++;
        } catch (e) {
          if ((e as { code?: number }).code === 6) continue; // もう送ってある
          logger.error('effect check failed', { uid, iid: d.id, error: String(e) });
        }
      }
    }
  }
  logger.info('effect checks', { written });
}

// ---- 課題のリマインド ----

/** これらのステータスの課題には、リマインドを届けない（もう取りかかることがない） */
const FINISHED = ['closed', 'deleted', 'merged', 'rejected'];

/**
 * 時刻が来たリマインドを、お知らせにして届け、リマインドは消す。
 * Admin はルールを通らないので、「課題がまだ動いているか」「本人が今もメンバーか」「アーカイブ中でないか」をここで確かめる
 */
async function sendReminders(now: Date) {
  const due = await db.collectionGroup('reminders').where('at', '<=', Timestamp.fromDate(now)).get();
  if (due.empty) return;
  let written = 0;
  await Promise.all(due.docs.map(async (r) => {
    const uid = r.ref.parent.parent?.id;
    if (!uid) return;
    const d = r.data();
    try {
      const [issue, member, project] = await Promise.all([
        db.doc(`projects/${d.pid}/issues/${d.iid}`).get(),
        db.doc(`projects/${d.pid}/members/${uid}`).get(),
        db.doc(`projects/${d.pid}`).get(),
      ]);
      const i = issue.data();
      // サブタスクのリマインドなら、サブタスクも読む（完了・切り出し済み・削除済みなら届けない）
      const sub = d.sid ? (await db.doc(`projects/${d.pid}/issues/${d.iid}/subtasks/${d.sid}`).get()).data() : null;
      const subOk = !d.sid || (!!sub && sub.status !== 'done' && !sub.splitTo);
      // 課題がない・終わった・本人が抜けた・アーカイブ中なら、届けずに消すだけ
      if (i && member.exists && !FINISHED.includes(i.status) && !project.get('archived') && subOk) {
        const n = i.number ?? d.number ?? null;
        const issueTitle = (i.title ?? d.title ?? '') as string;
        try {
          // 名札：同じリマインドが2回届かないように（関数が重なって動いても）
          await db.doc(`users/${uid}/notifications/reminder-${r.id}-${d.at.toMillis()}`).create({
            type: d.sid ? 'subtaskReminder' : 'reminder',
            pid: d.pid, projectName: project.get('name') ?? d.projectName ?? '', iid: d.iid, issueNumber: n,
            // サブタスクのときは、1行目に出す名前をサブタスク名に、2行目（detail）に「#番号 課題名」を入れる
            // （課題名が長くても、サブタスク名が読み切れるように）
            issueTitle: d.sid ? ((sub?.title ?? d.subTitle ?? '') as string).slice(0, 200) : issueTitle,
            detail: d.sid ? `#${n} ${issueTitle}`.slice(0, 200) : '',
            by: '', byName: '',
            at: FieldValue.serverTimestamp(), read: false,
            expireAt: Timestamp.fromMillis(now.getTime() + NOTIFY_KEEP_DAYS * DAY),
          });
          written++;
        } catch (e) {
          if ((e as { code?: number }).code !== 6) throw e; // ALREADY_EXISTS：もう届けてある
        }
      }
      // 消すのは届けたあと（先に消すと、届けるのに失敗したとき何も残らない）。
      // 待っている間に本人が時刻を変えていたら、消さない（変えた時刻に、改めて届く）
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(r.ref);
        if (cur.exists && cur.get('at')?.toMillis() === d.at.toMillis()) tx.delete(r.ref);
      });
    } catch (e) {
      logger.error('reminder failed', { uid, rid: r.id, error: String(e) });
    }
  }));
  logger.info('reminders', { due: due.size, written });
}

/** 10分ごとに起きて、毎朝のまとめの時刻になった人の分を作る（名前は以前のまま。変えると作り直しになるため） */
export const imHourly = onSchedule(
  { schedule: '*/10 * * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    const now = new Date();
    // 添付のための写しが、まだ一度もまとめて作られていなければ作る（2回目からは印を見て何もしない）
    await backfillMirror().catch((e) => logger.error('mirror backfill failed', { error: String(e) }));
    // 片方が失敗しても、もう片方は動かす
    await sendMorningSummaries(now).catch((e) => logger.error('morning summaries failed', { error: String(e) }));
    await sendReminders(now).catch((e) => logger.error('reminders failed', { error: String(e) }));
  },
);

// ---- プッシュ通知 ----

/**
 * プッシュの文面。受け取る人の言語で作る。
 * ※ src/app/i18n/ja.ts・en.ts の notify.types・notify.daily と同じに保つこと（片方を変えたら、もう片方も変える）
 */
const PUSH_TEXT: Record<'ja' | 'en', Record<string, string>> = {
  ja: {
    assigned: '{{name}} さんが、#{{n}}「{{title}}」の担当者をあなたにしました',
    comment: '{{name}} さんが、#{{n}}「{{title}}」にコメントしました',
    dueChanged: '{{name}} さんが、#{{n}}「{{title}}」の期限を変えました',
    resolved: '{{name}} さんが、#{{n}}「{{title}}」を解決済みにしました。確認をお願いします',
    sentBack: '{{name}} さんが、#{{n}}「{{title}}」を対応中に戻しました',
    closed: '{{name}} さんが、#{{n}}「{{title}}」をクローズしました',
    rejected: '{{name}} さんが、#{{n}}「{{title}}」を却下しました',
    restored: '{{name}} さんが、#{{n}}「{{title}}」を削除フォルダから復元しました',
    joined: '{{name}} さんが、招待を受けて「{{project}}」に参加しました',
    handover: '{{name}} さんから、「{{project}}」の課題 {{n}} 件の担当を引き継ぎました',
    daily: '今日のまとめ：{{parts}}',
    effectCheck: '#{{n}}「{{title}}」の効果を確かめる時期です。確かめて、クローズしてください',
    unblocked: '#{{n}}「{{title}}」が待っていた課題が、解決済みになりました。進められるか確かめてください',
    merged: '{{name}} さんが、#{{n}}「{{title}}」を別の課題に統合しました',
    projectDeleted: '{{name}} さんが、プロジェクト「{{project}}」を削除しました',
    subtaskAssigned: '{{name}} さんが、#{{n}}「{{title}}」のサブタスクをあなたの担当にしました',
    mention: '{{name}} さんが、#{{n}}「{{title}}」のコメントであなたをメンションしました',
    watchResolved: '{{name}} さんが、#{{n}}「{{title}}」を解決済みにしました',
    request: '{{name}} さんから、#{{n}}「{{title}}」について依頼が届きました',
    requestDone: '{{name}} さんが、#{{n}}「{{title}}」の依頼に対応しました',
    requestDeclined: '{{name}} さんが、#{{n}}「{{title}}」の依頼を見送りました',
    reminder: 'リマインド：#{{n}}「{{title}}」',
    subtaskReminder: 'リマインド：{{title}}',
  },
  en: {
    assigned: '{{name}} assigned you to #{{n}} "{{title}}"',
    comment: '{{name}} commented on #{{n}} "{{title}}"',
    dueChanged: '{{name}} changed the due date of #{{n}} "{{title}}"',
    resolved: '{{name}} resolved #{{n}} "{{title}}". Please check it',
    sentBack: '{{name}} sent #{{n}} "{{title}}" back to In progress',
    closed: '{{name}} closed #{{n}} "{{title}}"',
    rejected: '{{name}} rejected #{{n}} "{{title}}"',
    restored: '{{name}} restored #{{n}} "{{title}}" from the trash',
    joined: '{{name}} accepted the invitation and joined "{{project}}"',
    handover: '{{name}} handed over {{n}} issues in "{{project}}" to you',
    daily: 'Today: {{parts}}',
    effectCheck: 'Time to check whether #{{n}} "{{title}}" worked. Check the effect and close it',
    unblocked: 'The issue that #{{n}} "{{title}}" was waiting for is resolved. Check whether you can move forward',
    merged: '{{name}} merged #{{n}} "{{title}}" into another issue',
    projectDeleted: '{{name}} deleted the project "{{project}}"',
    subtaskAssigned: '{{name}} assigned you a subtask on #{{n}} "{{title}}"',
    mention: '{{name}} mentioned you in a comment on #{{n}} "{{title}}"',
    watchResolved: '{{name}} resolved #{{n}} "{{title}}"',
    request: '{{name}} sent a request about #{{n}} "{{title}}"',
    requestDone: '{{name}} acted on your request about #{{n}} "{{title}}"',
    requestDeclined: '{{name}} declined your request about #{{n}} "{{title}}"',
    reminder: 'Reminder: #{{n}} "{{title}}"',
    subtaskReminder: 'Reminder: {{title}}',
  },
};
const DAILY_PARTS: Record<'ja' | 'en', Record<string, string>> = {
  ja: { overdue: '期限切れ {{n}}件', today: '今日まで {{n}}件', tomorrow: '明日まで {{n}}件',
    in3: '2〜3日後まで {{n}}件', inboxOld: '受信箱（7日以上）{{n}}件',
    high: '優先度「高」{{n}}件', mid: '「中」{{n}}件', low: '「低」{{n}}件',
    active: '未完了 {{n}}件（{{p}}人）', overdueAll: '期限切れ {{n}}件（{{p}}人）' },
  en: { overdue: '{{n}} overdue', today: '{{n}} due today', tomorrow: '{{n}} due tomorrow',
    in3: '{{n}} due in 2–3 days', inboxOld: '{{n}} old inbox notes',
    high: '{{n}} high priority', mid: '{{n}} medium', low: '{{n}} low',
    active: '{{n}} open ({{p}} people)', overdueAll: '{{n}} overdue ({{p}} people)' },
};
/**
 * 形ごとの、並べる順番。人数を添える区分は、人数の入っている数の名前も
 * ※ アプリの notification.service.ts の DAILY_KEYS・PEOPLE_OF と同じに保つこと
 */
const DAILY_KEYS: Record<DailyGroup, string[]> = {
  due: ['overdue', 'today', 'tomorrow', 'in3', 'inboxOld'],
  priority: ['high', 'mid', 'low', 'inboxOld'],
  assignee: ['active', 'overdueAll', 'inboxOld'],
};
const PEOPLE_OF: Record<string, string> = { active: 'people', overdueAll: 'overduePeople' };
const APP_TITLE = { ja: '課題管理', en: 'Issue Tracker' };

/** {{名前}} を値で置き換える */
function fill(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '');
}

/** 通知の文書から、プッシュの本文を作る */
function pushBody(n: DocumentData, lang: 'ja' | 'en'): string {
  if (n.type === 'daily' && n.counts) {
    const c = n.counts;
    const parts = DAILY_KEYS[dailyGroupOf(n.group)]
      .filter((k) => (c[k] ?? 0) > 0)
      .map((k) => fill(DAILY_PARTS[lang][k], { n: String(c[k]), p: String(c[PEOPLE_OF[k]] ?? '') }))
      .join(lang === 'ja' ? '・' : ', ');
    return fill(PUSH_TEXT[lang].daily, { parts });
  }
  return fill(PUSH_TEXT[lang][n.type] ?? '', {
    name: n.byName ?? '', n: String(n.issueNumber ?? ''), title: n.issueTitle ?? '', project: n.projectName ?? '',
  });
}

/** 押したときに開く画面（アプリのヘッダーの openNotice と同じ行き先） */
function pushUrl(uid: string, n: DocumentData): string {
  if (n.type === 'daily') return '/#today';
  if (n.type === 'projectDeleted') return '/';
  if (n.iid) return `/p/${n.pid}/i/${n.iid}`;
  if (n.type === 'handover') return `/p/${n.pid}/list?assignee=${uid}`;
  return `/p/${n.pid}`;
}

/**
 * 通知の文書ができたら、その人の端末にプッシュを送る。
 * 出来事の通知（画面が書く）も、朝のまとめ・効果確認（関数が書く）も、すべてここを通る
 */
export const imOnNotification = onDocumentCreated(
  { document: 'users/{uid}/notifications/{nid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const n = event.data?.data();
    if (!n) return;
    const uid = event.params.uid;
    // 宛先の人の端末にだけ送る（端末を登録していなければ、何もしない）
    const devices = await db.collection(`users/${uid}/devices`).get();
    if (devices.empty) return;
    const user = await db.doc(`users/${uid}`).get();
    const lang: 'ja' | 'en' = user.get('language') === 'en' ? 'en' : 'ja';
    // data に入れたものは、すべて文字列にする（サービスワーカーが title・body・url として読む）
    const data = {
      title: n.projectName || APP_TITLE[lang],
      body: pushBody(n, lang),
      url: pushUrl(uid, n),
    };
    await Promise.all(devices.docs.map(async (d) => {
      try {
        await getMessaging().send({ fid: d.id, data });
      } catch (e) {
        const code = (e as { code?: string }).code ?? '';
        // もう使えない端末（アンインストール・ブラウザのデータ削除など）は、登録を消す
        if (code.includes('not-registered') || code.includes('unregistered')) {
          await d.ref.delete();
          logger.info('removed stale device', { uid, fid: d.id });
        } else {
          logger.error('push failed', { uid, fid: d.id, code, error: String(e) });
        }
      }
    }));
  },
);

// ---- 完了待ちの解消 ----

/**
 * 課題が解決済みになったら、その課題を「完了待ち」にしている課題の担当者に知らせる。
 * 待っている課題は別のプロジェクトのこともあり、解決した人の画面からはルールで書けないので、ここで書く。
 * Admin はルールを通らないので、「未完了か」「担当者が今もメンバーか」を自分で確かめる
 */
export const imOnIssueResolved = onDocumentUpdated(
  { document: 'projects/{pid}/issues/{iid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    // 「解決済み以外 → 解決済み」の瞬間だけ（ほかの編集では何もしない）
    if (!before || !after || before.status === 'resolved' || after.status !== 'resolved') return;
    const { pid, iid } = event.params;

    // この課題を待っている課題（相手から付けられた「完了待ち」）
    const links = await db.collection(`projects/${pid}/issues/${iid}/links`)
      .where('kind', '==', 'waitsFor').where('dir', '==', 'in').get();
    if (links.empty) return;

    const resolvedMs = after.resolvedAt?.toMillis?.() ?? Date.now();
    let written = 0;
    await Promise.all(links.docs.map(async (l) => {
      const wpid = l.get('pid') as string;
      const wiid = l.get('iid') as string;
      try {
        const [waiting, wproject] = await Promise.all([
          db.doc(`projects/${wpid}/issues/${wiid}`).get(),
          db.doc(`projects/${wpid}`).get(),
        ]);
        const w = waiting.data();
        // 待っている課題が、もう無い・終わっている・アーカイブ中なら送らない
        if (!w || !ACTIVE.includes(w.status) || !w.assigneeId || wproject.get('archived')) return;
        const to = w.assigneeId as string;
        // 解決した本人が担当者なら、知らせるまでもない
        if (to === after.updatedBy) return;
        const [member, canSeeResolved] = await Promise.all([
          db.doc(`projects/${wpid}/members/${to}`).get(),
          db.doc(`projects/${pid}/members/${to}`).get(),
        ]);
        if (!member.exists) return;
        // 解決した課題の番号と題名は、宛先がそのプロジェクトのメンバーのときだけ添える
        const detail = canSeeResolved.exists ? `#${after.number}「${after.title}」`.slice(0, 200) : '';
        // 名札：同じ解決で2通にならない。差し戻して解決し直したら、時刻が変わるので改めて届く
        await db.doc(`users/${to}/notifications/unblocked-${wiid}-${iid}-${resolvedMs}`).create({
          type: 'unblocked', pid: wpid, projectName: wproject.get('name') ?? '', iid: wiid,
          issueNumber: w.number ?? null, issueTitle: w.title ?? '',
          by: after.updatedBy ?? '', byName: '', detail,
          at: FieldValue.serverTimestamp(), read: false,
          expireAt: Timestamp.fromMillis(Date.now() + NOTIFY_KEEP_DAYS * DAY),
        });
        written++;
      } catch (e) {
        if ((e as { code?: number }).code === 6) return; // もう送ってある
        logger.error('unblocked notice failed', { pid, iid, wpid, wiid, error: String(e) });
      }
    }));
    logger.info('unblocked notices', { pid, iid, written });
  },
);

// ---- プロジェクトの削除 ----

/**
 * プロジェクトを完全に削除する（画面から呼ぶ）。管理者だけ・アーカイブ済みだけ・名前の打ち込みが一致したときだけ。
 * Admin はルールを通らないので、条件はすべてここで確かめる。画面からは消さない（ルールは delete: false のまま）
 */
export const imDeleteProject = onCall({ region: 'asia-northeast1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'sign-in required');
  const pid = String(req.data?.pid ?? '');
  const typed = String(req.data?.name ?? '');
  if (!pid) throw new HttpsError('invalid-argument', 'pid required');

  const projectRef = db.doc(`projects/${pid}`);
  const [project, me] = await Promise.all([projectRef.get(), projectRef.collection('members').doc(uid).get()]);
  if (!project.exists) throw new HttpsError('not-found', 'project not found');
  if (me.get('role') !== 'admin') throw new HttpsError('permission-denied', 'admin only');
  if (project.get('archived') !== true) throw new HttpsError('failed-precondition', 'archive first');
  const name = (project.get('name') as string) ?? '';
  if (typed !== name) throw new HttpsError('failed-precondition', 'name mismatch');
  const byName = (me.get('displayName') as string) ?? '';
  const r = await purgeProject(pid, name, uid, byName);
  // 管理ログも消えるので、だれが・いつ・何を消したかは、関数のログに残す
  logger.info('project deleted', { pid, name, by: uid, byName, ...r });
  return { ok: true };
});

/**
 * プロジェクトを中身ごと消す（プロジェクトの削除と、アカウントの削除で使う）。
 * 「消してよいか」の確かめは、呼ぶ側で済ませておくこと
 */
async function purgeProject(pid: string, name: string, by: string, byName: string) {
  const projectRef = db.doc(`projects/${pid}`);
  // ① 「削除の最中」の旗を立てる。開いている画面は、これを見てホームへ戻る（「外されました」と区別するため）
  await projectRef.update({ deleting: true });

  // ② ほかのプロジェクトに残る、関連課題の対の1枚を消す（相手の画面に「閲覧できない課題」を残さない）
  const issueRefs = await projectRef.collection('issues').listDocuments();
  const linkSnaps = await Promise.all(issueRefs.map((r) => r.collection('links').get()));
  const partners = linkSnaps.flatMap((s, i) => s.docs
    .filter((l) => l.get('pid') !== pid)
    .map((l) => {
      const pairDir = l.get('dir') === 'out' ? 'in' : 'out';
      return db.doc(`projects/${l.get('pid')}/issues/${l.get('iid')}/links/` +
        `${l.get('kind')}_${pairDir}_${pid}_${issueRefs[i].id}`);
    }));
  await Promise.allSettled(partners.map((r) => r.delete()));

  // ③ ほかのメンバーに知らせる（届いた通知は、今ある imOnNotification がプッシュにする）
  const members = await projectRef.collection('members').get();
  const expireAt = Timestamp.fromMillis(Date.now() + NOTIFY_KEEP_DAYS * DAY);
  await Promise.allSettled(members.docs.filter((m) => m.id !== by).map((m) =>
    db.collection(`users/${m.id}/notifications`).add({
      type: 'projectDeleted', pid, projectName: name, iid: null, issueNumber: null, issueTitle: '',
      by, byName, detail: '', at: FieldValue.serverTimestamp(), read: false, expireAt,
    })));

  // ④ プロジェクトと、その下の全部（課題・経緯・コメント・関連課題・メンバー・招待・管理ログ）を消す
  await db.recursiveDelete(projectRef);
  // 一覧の文書が消えれば関数がファイルも消すが、取りこぼしがないよう、置き場所ごと片づける
  await getStorage().bucket(BUCKET).deleteFiles({ prefix: `projects/${pid}/` })
    .catch((e) => logger.error('project files delete failed', { pid, error: String(e) }));
  return { members: members.size, issues: issueRefs.length };
}

// ---- アカウントの削除 ----

/** 引き継ぎの対象になる、まだ終わっていない課題（画面の changeMember の OPEN_STATUSES と同じ） */
const OPEN = ['open', 'in_progress', 'on_hold', 'resolved'];
/** ログインし直してから、削除を受け付ける時間（秒） */
const RECENT_LOGIN_SEC = 5 * 60;

/** 所属するプロジェクトごとの扱い。purge＝一緒に削除、leave＝抜ける、blocked＝ほかに管理者がいないので止める */
interface AccountPlan {
  pid: string;
  name: string;
  kind: 'purge' | 'leave' | 'blocked';
  myName: string;
  myRole: string;
  others: { uid: string; role: string }[];
  issues: DocumentReference[];   // 自分が担当の、未完了の課題
}

/**
 * アカウントを削除する（画面から呼ぶ）。
 * 他人の課題の担当を書き換える・他人のプロジェクトに記録を残す・ログインを消す、はどれも画面のルールでは許していないので、
 * ここで行う。Admin はルールを通らないので、条件はすべてここで確かめる
 */
export const imDeleteAccount = onCall({ region: 'asia-northeast1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'sign-in required');
  // ① ログインし直してから5分以内か（画面の確認だけだと、関数を直接呼ばれたときに素通りになるため）
  const authTime = Number(req.auth?.token.auth_time ?? 0);
  if (Date.now() / 1000 - authTime > RECENT_LOGIN_SEC) throw new HttpsError('failed-precondition', 'recent-login');
  const handovers = (req.data?.handovers ?? {}) as Record<string, string>;
  const reason = String(req.data?.reason ?? '').slice(0, 1000);
  const tz = safeTz((await db.doc(`users/${uid}`).get()).get('timeZone'));

  // ② 所属するプロジェクトを3つに分ける（画面と同じ決まりを、ここでもう一度。開いたあとに状況が変わりうるため）
  const mine = await db.collectionGroup('members').where('uid', '==', uid).get();
  const plans = await Promise.all(mine.docs.map(async (m): Promise<AccountPlan> => {
    const projectRef = m.ref.parent.parent!;
    const [project, members, assigned] = await Promise.all([
      projectRef.get(),
      projectRef.collection('members').get(),
      projectRef.collection('issues').where('assigneeId', '==', uid).get(),
    ]);
    const others = members.docs.filter((d) => d.id !== uid).map((d) => ({ uid: d.id, role: d.get('role') as string }));
    const kind = !others.length ? 'purge'
      : m.get('role') === 'admin' && !others.some((o) => o.role === 'admin') ? 'blocked' : 'leave';
    return {
      pid: projectRef.id, name: (project.get('name') as string) ?? '', kind,
      myName: (m.get('displayName') as string) ?? '', myRole: m.get('role') as string, others,
      issues: assigned.docs.filter((d) => OPEN.includes(d.get('status'))).map((d) => d.ref),
    };
  }));

  // ③ 先に全部確かめる（途中まで消してから止まると、半端な状態が残るため）
  if (plans.some((p) => p.kind === 'blocked')) throw new HttpsError('failed-precondition', 'blocked');
  for (const p of plans) {
    if (p.kind !== 'leave' || !p.issues.length) continue;
    const to = handovers[p.pid];
    // 引き継ぐ人は、そのプロジェクトの管理者かメンバー（閲覧者は担当者になれない）
    if (!p.others.some((o) => o.uid === to && o.role !== 'viewer')) {
      throw new HttpsError('failed-precondition', 'handover');
    }
  }

  // ④ 抜けるプロジェクト：1つずつトランザクションで（引き継ぎ・名前を残す・メンバーから外す・記録・知らせ）
  for (const p of plans.filter((x) => x.kind === 'leave')) {
    const projectRef = db.doc(`projects/${p.pid}`);
    const to = handovers[p.pid];
    await db.runTransaction(async (tx) => {
      // 読むのが先、書くのが後
      const snaps = p.issues.length ? await tx.getAll(...p.issues) : [];
      let moved = 0;
      for (const s of snaps) {
        // ③のあとに、ほかの人が担当を変えた・終わらせたものは触らない
        if (!s.exists || s.get('assigneeId') !== uid || !OPEN.includes(s.get('status'))) continue;
        tx.update(s.ref, { assigneeId: to, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
        tx.create(s.ref.collection('events').doc(), {
          type: 'edit', fields: ['assigneeId'], changes: { assigneeId: { from: uid, to } },
          reason, by: uid, tz, at: FieldValue.serverTimestamp(),
        });
        moved++;
      }
      // 名前を残してから消す（コメントや経緯で「—」にしないため。抜けるときと同じ）
      tx.update(projectRef, { [`formerMembers.${uid}`]: p.myName });
      tx.delete(projectRef.collection('members').doc(uid));
      tx.create(projectRef.collection('adminLogs').doc(), {
        type: 'account', by: uid, target: uid, from: p.myRole, to: null, moved, at: FieldValue.serverTimestamp(),
      });
      if (moved) {
        tx.create(db.collection(`users/${to}/notifications`).doc(), {
          type: 'handover', pid: p.pid, projectName: p.name, iid: null, issueNumber: moved, issueTitle: '',
          by: uid, byName: p.myName, detail: reason.slice(0, 200), at: FieldValue.serverTimestamp(), read: false,
          expireAt: Timestamp.fromMillis(Date.now() + NOTIFY_KEEP_DAYS * DAY),
        });
      }
    });
  }

  // ⑤ 自分しかいないプロジェクト：プロジェクトの削除と同じ片づけ
  for (const p of plans.filter((x) => x.kind === 'purge')) {
    await purgeProject(p.pid, p.name, uid, p.myName);
  }
  // ⑥ 自分の置き場（受信箱・お知らせ・端末・リマインド）
  await db.recursiveDelete(db.doc(`users/${uid}`));
  // ⑦ 最後にログインを消す（途中で失敗しても、ログインが残っていれば、本人がもう一度押してやり直せる）
  await getAuth().deleteUser(uid);

  logger.info('account deleted', {
    uid, left: plans.filter((p) => p.kind === 'leave').length, purged: plans.filter((p) => p.kind === 'purge').length,
  });
  return { ok: true };
});

// ---- サブタスクの数 ----

/**
 * サブタスクが作られた・変わった・消えたら、課題の subtaskTotal・subtaskDone を数え直す（切り出したものは除く）。
 * 課題の updatedAt は変えない（衝突も、停滞のリセットも起こさないため）
 */
export const imOnSubtaskChanged = onDocumentWritten(
  { document: 'projects/{pid}/issues/{iid}/subtasks/{sid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    // 数に関係する変更（作った・消した・状態・切り出し）の瞬間だけ。タイトルやメモの直し、並べ替えでは何もしない
    // 担当者が変わったときも、「サブタスクの担当者の一覧」が変わるので、数え直す
    if (before && after && before.status === after.status && !!before.splitTo === !!after.splitTo
      && before.assigneeId === after.assigneeId) return;

    const { pid, iid } = event.params;
    const issueRef = db.doc(`projects/${pid}/issues/${iid}`);
    // 数えるのと書くのを1つのトランザクションに。□ を続けて押して関数が同時に動いても、古い数で上書きしない
    await db.runTransaction(async (tx) => {
      const issue = await tx.get(issueRef);
      if (!issue.exists) return; // 完全削除・プロジェクトの削除の途中（親がもう無い）
      const subs = await tx.get(issueRef.collection('subtasks'));
      const counted = subs.docs.filter((d) => !d.get('splitTo'));
      const total = counted.length;
      const done = counted.filter((d) => d.get('status') === 'done').length;
      // 未完了のサブタスクの担当者（重複なし・並びをそろえる）。ホームの「サブタスクの担当」の見張りに使う
      const assignees = [...new Set(counted
        .filter((d) => d.get('status') !== 'done')
        .map((d) => d.get('assigneeId') as string))].sort();
      const prev = ((issue.get('subtaskAssignees') as string[] | undefined) ?? []).join();
      // 変わっていなければ書かない（書くと、課題を見張っている全員の画面に、要らない知らせが飛ぶため）
      if (issue.get('subtaskTotal') === total && issue.get('subtaskDone') === done && prev === assignees.join()) return;
      tx.update(issueRef, { subtaskTotal: total, subtaskDone: done, subtaskAssignees: assignees });
    });
  },
);

// ---- 添付 ----

/**
 * 添付の一覧の文書が消えたら、ファイル本体も消す。
 * 1つずつの削除・コメントの削除・課題の完全削除・プロジェクトの削除（recursiveDelete）は、どれもここを通る
 */
export const imOnAttachmentDeleted = onDocumentDeleted(
  { document: 'projects/{pid}/issues/{iid}/attachments/{aid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const path = event.data?.get('path') as string | undefined;
    if (!path) return;
    try {
      await getStorage().bucket(BUCKET).file(path).delete({ ignoreNotFound: true });
    } catch (e) {
      logger.error('attachment file delete failed', { path, error: String(e) });
    }
  },
);

// ---- 添付のための写し（(default) のデータベースへ） ----

/**
 * Storage のルールは、名前付きのデータベース（issuemanager）を見に行けない（10/20 に確かめた）。
 * そのため、「だれが、どのプロジェクトの、どの役割か」と「アーカイブ中か」だけを、(default) に写しておく。
 * 置き場所：imProjects/{pid}（archived）、imProjects/{pid}/members/{uid}（role）。画面からは読み書きしない
 */
const mirrorDb = getFirestore(); // (default)。ここだけは、わざとデータベースの名前を書かない
/** 最初のまとめての写しが済んだかの印（中身を変えたら、数を上げると、もう一度まとめて写す） */
const MIRROR_VERSION = 1;

/** メンバーが増えた・役割が変わった・抜けたら、写しを直す */
export const imMirrorMember = onDocumentWritten(
  { document: 'projects/{pid}/members/{uid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const { pid, uid } = event.params;
    const after = event.data?.after.data();
    const ref = mirrorDb.doc(`imProjects/${pid}/members/${uid}`);
    if (!after) {
      await ref.delete(); // 外れた・抜けた
      return;
    }
    // 役割が変わったときだけ書く（表示名などの変更では書かない）
    if (event.data?.before.data()?.role === after.role) return;
    await ref.set({ role: after.role });
  },
);

/** プロジェクトを作った・アーカイブした・解除した・削除したら、写しを直す */
export const imMirrorProject = onDocumentWritten(
  { document: 'projects/{pid}', database: 'issuemanager', region: 'asia-northeast1' },
  async (event) => {
    const { pid } = event.params;
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const ref = mirrorDb.doc(`imProjects/${pid}`);
    if (!after) {
      await mirrorDb.recursiveDelete(ref); // プロジェクトの削除：写しもメンバーごと消す
      return;
    }
    // アーカイブの状態が変わったとき（と、作ったとき）だけ書く。課題の番号の採番などでは書かない
    if (before && !!before.archived === !!after.archived) return;
    await ref.set({ archived: !!after.archived });
  },
);

/** 最初に1回だけ、今いる全プロジェクト・全メンバーを写す（印があれば何もしない） */
async function backfillMirror() {
  const meta = mirrorDb.doc('imMeta/mirror');
  if ((await meta.get()).get('version') === MIRROR_VERSION) return;
  const [projects, members] = await Promise.all([
    db.collection('projects').get(),
    db.collectionGroup('members').get(),
  ]);
  const writes: { ref: DocumentReference; data: DocumentData }[] = [
    ...projects.docs.map((p) => ({ ref: mirrorDb.doc(`imProjects/${p.id}`), data: { archived: !!p.get('archived') } })),
    ...members.docs
      .filter((m) => m.ref.parent.parent)
      .map((m) => ({
        ref: mirrorDb.doc(`imProjects/${m.ref.parent.parent!.id}/members/${m.id}`),
        data: { role: m.get('role') },
      })),
  ];
  // まとめ書きは1回500件まで。余裕をみて400件ずつ
  for (let i = 0; i < writes.length; i += 400) {
    const batch = mirrorDb.batch();
    writes.slice(i, i + 400).forEach((w) => batch.set(w.ref, w.data));
    await batch.commit();
  }
  await meta.set({ version: MIRROR_VERSION, at: FieldValue.serverTimestamp() });
  logger.info('mirror backfilled', { projects: projects.size, members: members.size });
}