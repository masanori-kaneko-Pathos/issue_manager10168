import { initializeApp } from 'firebase-admin/app';
import { DocumentData, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

initializeApp();
/** 課題管理アプリのデータベース。名前を指定しないと (default) を読んでしまう */
const db = getFirestore('issuemanager');

const DAY = 24 * 60 * 60 * 1000;
/** 通知が自動で消えるまでの日数（アプリ側の NOTIFY_KEEP_DAYS と同じ） */
const NOTIFY_KEEP_DAYS = 90;
/** 受信箱のメモが「古い」とされる日数（アプリ側の INBOX_OLD_DAYS と同じ） */
const INBOX_OLD_DAYS = 7;
/** 未完了のステータス（まとめで数えるもの。削除・クローズ・却下・解決済みは数えない） */
const ACTIVE = ['open', 'in_progress', 'on_hold'];
const DEFAULT_TZ = 'Asia/Tokyo';
const DEFAULT_NOTIFY_HOUR = 10;
const DEFAULT_REMINDERS = ['today', 'tomorrow', 'in3'];

type Bucket = 'overdue' | 'today' | 'tomorrow' | 'in3';

// ---- 時刻の道具（アプリの time.ts と同じ決まり） ----

/** 瞬間を、timeZone での日付（YYYY-MM-DD）にする */
function dateKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}

/** 瞬間の、timeZone での「時」（0〜23） */
function hourIn(d: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
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

// ---- 朝のまとめ ----

interface Target {
  uid: string;
  tz: string;
  hour: number;          // その人の現地の「時」（文書IDに使う）
  reminders: string[];   // 期限前の通知で数える区分
  pids: string[];        // 今が通知時刻になったプロジェクト
}

/**
 * 朝のまとめ：今、現地時間がプロジェクトの通知時刻になった人に、1人1通書く。
 * Functions はルールを通らないので、「アーカイブ中は飛ばす」「未完了だけ数える」「メンバーにだけ送る」を、ここで確かめる
 */
async function sendMorningSummaries(now: Date) {
  // ① アーカイブ中でないプロジェクト
  const projects = new Map((await db.collection('projects').where('archived', '==', false).get())
    .docs.map((p) => [p.id, p.data()]));
  if (!projects.size) return;

  // ② メンバー（全プロジェクト分を1回で読む）→ 人ごとの所属プロジェクト
  const projectsOf = new Map<string, string[]>();
  for (const m of (await db.collectionGroup('members').get()).docs) {
    const pid = m.ref.parent.parent?.id;
    if (!pid || !projects.has(pid)) continue;
    projectsOf.set(m.id, [...(projectsOf.get(m.id) ?? []), pid]);
  }
  if (!projectsOf.size) return;

  // ③ 今が通知時刻の人を探す（タイムゾーンと期限前の選択は users から）
  const users = await db.getAll(...[...projectsOf.keys()].map((uid) => db.doc(`users/${uid}`)));
  const targets: Target[] = [];
  for (const u of users) {
    if (!u.exists) continue;
    const tz = safeTz(u.get('timeZone'));
    const hour = hourIn(now, tz);
    const pids = (projectsOf.get(u.id) ?? []).filter(
      (pid) => (projects.get(pid)?.settings?.notifyHour ?? DEFAULT_NOTIFY_HOUR) === hour);
    if (pids.length) {
      targets.push({ uid: u.id, tz, hour, reminders: u.get('dueReminders') ?? DEFAULT_REMINDERS, pids });
    }
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
}

/** 1人分のまとめを数えて書く。書いたら true（何もない・もう書いてあるなら false） */
async function writeSummary(t: Target, openByPid: Map<string, DocumentData[]>, now: Date): Promise<boolean> {
  const counts = { overdue: 0, today: 0, tomorrow: 0, in3: 0, inboxOld: 0 };
  for (const pid of t.pids) {
    for (const i of openByPid.get(pid) ?? []) {
      if (i.assigneeId !== t.uid || !i.dueAt) continue;
      const b = dueBucket(i.dueAt.toMillis(), now.getTime(), t.tz);
      // 期限切れはいつも数える。期限前は、その人が選んだ区分だけ
      if (b && (b === 'overdue' || t.reminders.includes(b))) counts[b]++;
    }
  }
  // 受信箱：7日以上たった、ゴミ箱に入れていないメモ
  const old = await db.collection(`users/${t.uid}/inbox`)
    .where('createdAt', '<=', Timestamp.fromMillis(now.getTime() - INBOX_OLD_DAYS * DAY)).get();
  counts.inboxOld = old.docs.filter((d) => !d.get('discardedAt')).length;

  // 何もなければ送らない（「0件です」の通知は雑音になる）
  if (!Object.values(counts).some((n) => n > 0)) return false;

  // 文書IDを「日付と時」で決める → 同じ時刻に2回動いても、2回目は「もうある」で止まる
  const ref = db.doc(`users/${t.uid}/notifications/daily-${dateKey(now, t.tz)}-${t.hour}`);
  try {
    await ref.create({
      type: 'daily', pid: '', projectName: '', iid: null, issueNumber: null, issueTitle: '',
      by: '', byName: '', detail: '', counts,
      at: FieldValue.serverTimestamp(), read: false,
      expireAt: Timestamp.fromMillis(now.getTime() + NOTIFY_KEEP_DAYS * DAY),
    });
    return true;
  } catch (e) {
    if ((e as { code?: number }).code === 6) return false; // ALREADY_EXISTS：この時刻の分はもう書いてある
    throw e;
  }
}

/** 毎時0分に起きて、通知時刻になった人の分を作る */
export const imHourly = onSchedule(
  { schedule: '0 * * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    await sendMorningSummaries(new Date());
  },
);