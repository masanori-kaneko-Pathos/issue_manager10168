import { initializeApp } from 'firebase-admin/app';
import { DocumentData, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
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
const DEFAULT_EFFECT_DAYS = 7;

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

  // ⑥ 効果確認（解決済みにしてから、決まった日数がたった課題）
  await sendEffectChecks(targets, projects, membersOf, now);
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
        // 今が通知時刻になった人で、このプロジェクトの時刻が今のときだけ
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

/** 毎時0分に起きて、通知時刻になった人の分を作る */
export const imHourly = onSchedule(
  { schedule: '0 * * * *', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    await sendMorningSummaries(new Date());
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
  },
};
const DAILY_PARTS: Record<'ja' | 'en', Record<string, string>> = {
  ja: { overdue: '期限切れ {{n}}件', today: '今日まで {{n}}件', tomorrow: '明日まで {{n}}件',
    in3: '2〜3日後まで {{n}}件', inboxOld: '受信箱（7日以上）{{n}}件' },
  en: { overdue: '{{n}} overdue', today: '{{n}} due today', tomorrow: '{{n}} due tomorrow',
    in3: '{{n}} due in 2–3 days', inboxOld: '{{n}} old inbox notes' },
};
const APP_TITLE = { ja: '課題管理', en: 'Issue Tracker' };

/** {{名前}} を値で置き換える */
function fill(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k] ?? '');
}

/** 通知の文書から、プッシュの本文を作る */
function pushBody(n: DocumentData, lang: 'ja' | 'en'): string {
  if (n.type === 'daily' && n.counts) {
    const parts = ['overdue', 'today', 'tomorrow', 'in3', 'inboxOld']
      .filter((k) => n.counts[k] > 0)
      .map((k) => fill(DAILY_PARTS[lang][k], { n: String(n.counts[k]) }))
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