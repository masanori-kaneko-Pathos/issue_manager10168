import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

initializeApp();
/** 課題管理アプリのデータベース。名前を指定しないと (default)＝リマインダーアプリのほうを読んでしまう */
const db = getFirestore('issuemanager');

/**
 * 試しの関数：1時間ごとに起きて、プロジェクトの数をログに出すだけ。
 * 明日、これを「10時になった人に、まとめと期限前の通知を作る」関数に育てる
 */
export const imHourly = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Asia/Tokyo', region: 'asia-northeast1' },
  async () => {
    const snap = await db.collection('projects').count().get();
    logger.info('issuemanager projects', { count: snap.data().count });
  },
);