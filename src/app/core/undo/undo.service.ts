import { Injectable, signal } from '@angular/core';

/** 知らせを出しておく時間（赤Q） */
const SHOW_MS = 8000;
/** 戻したあと・戻せなかったときの知らせを出す時間 */
const RESULT_MS = 4000;

/** 戻そうとしたら、ほかの人がもう同じところを変えていた（黙って上書きしないため、戻さない） */
export class UndoConflictError extends Error {
  constructor() {
    super('undo-conflict');
  }
}

/** 画面の下の知らせの中身。canUndo が false のときは、結果を知らせるだけ */
export interface UndoNotice { key: string; params?: Record<string, string>; canUndo: boolean; }

/**
 * 「元に戻す」。アプリ全体で1つだけ持つ。新しい操作をすると、前の「元に戻す」は消える。
 * 戻す処理は、逆向きの変更をもう1回保存する（経緯には両方残る）
 */
@Injectable({ providedIn: 'root' })
export class UndoService {
  readonly notice = signal<UndoNotice | null>(null);
  readonly busy = signal(false);
  private action: (() => Promise<unknown>) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** 保存に成功したあとに呼ぶ。戻す処理を預かり、知らせを出す */
  offer(key: string, params: Record<string, string> | undefined, run: () => Promise<unknown>) {
    this.action = run;
    this.notice.set({ key, params, canUndo: true });
    this.startTimer(SHOW_MS);
  }

  /** 「元に戻す」（ボタンか Ctrl＋Z） */
  async undo() {
    const run = this.action;
    if (!run || this.busy()) return;
    this.action = null; // 二度押しで2回戻さない
    this.busy.set(true);
    clearTimeout(this.timer);
    try {
      await run();
      this.show('undo.done');
    } catch (e) {
      if (!(e instanceof UndoConflictError)) console.error(e);
      this.show(e instanceof UndoConflictError ? 'undo.conflict' : 'common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  get canUndo() {
    return !!this.action;
  }

  dismiss() {
    clearTimeout(this.timer);
    this.action = null;
    this.notice.set(null);
  }

  /** マウスが乗っている間は消さない。離れたら、少し待って消す */
  pause() {
    clearTimeout(this.timer);
  }
  resume() {
    if (this.notice()) this.startTimer(RESULT_MS);
  }

  private show(key: string) {
    this.notice.set({ key, canUndo: false });
    this.startTimer(RESULT_MS);
  }

  private startTimer(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dismiss(), ms);
  }
}