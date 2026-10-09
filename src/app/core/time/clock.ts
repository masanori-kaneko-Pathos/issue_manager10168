import { Injectable, signal } from '@angular/core';

/** 時計が進む間隔*/
const TICK_MS = 60_000;

/** アプリ全体で1つの時計。残り時間・期限切れ・優先度・「今日」の表示は、これを読む */
@Injectable({ providedIn: 'root' })
export class Clock {
  /** 今の時刻（ミリ秒）。1分ごとに進む */
  readonly now = signal(Date.now());

  constructor() {
    setInterval(() => this.now.set(Date.now()), TICK_MS);
    // 別のタブから戻ってきたときも、すぐ合わせる
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.now.set(Date.now());
    });
  }
}