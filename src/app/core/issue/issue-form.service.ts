import { Injectable, InjectionToken, signal } from '@angular/core';

/** 登録画面を、窓として開いたときに受け取る値。無ければ、ふつうのページ */
export interface IssueNewEmbed {
  /** 開いた元のプロジェクト（ヘッダーなど、プロジェクトの外からなら null） */
  pid: string | null;
  /** URL の ? の代わり（memo・due・assignee・copy・from・recur・splitOf・sub・draft） */
  query: Record<string, string>;
  /** 登録できた */
  done(r: { pid: string; iid: string; number: number }): void;
  /** 閉じる（書きかけは、登録画面が下書きにしまってから閉じる） */
  close(): void;
}
/**
 * 登録画面に「窓として開かれた」と伝える札。
 * 登録画面のファイルとは分けて置く（最初に読む所から登録画面を import すると、画面ごと最初の読み込みに混ざるため）
 */
export const ISSUE_NEW_EMBED = new InjectionToken<IssueNewEmbed>('IssueNewEmbed');

/** 課題の登録の窓の係。どの画面も「この値で開いて」と頼むだけ。窓はアプリに1つ */
@Injectable({ providedIn: 'root' })
export class IssueFormService {
  /** 開いている窓（key は開くたびに変える＝同じ値で開き直しても、中を作り直す） */
  readonly current = signal<{ pid: string | null; query: Record<string, string>; key: number } | null>(null);
  /** 登録できたことの知らせ（6秒） */
  readonly created = signal<{ pid: string; iid: string; number: number } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  open(pid: string | null, query: Record<string, string> = {}) {
    this.current.set({ pid, query, key: Date.now() });
  }

  close() {
    this.current.set(null);
  }

  done(r: { pid: string; iid: string; number: number }) {
    this.current.set(null);
    this.created.set(r);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.created.set(null), 6000);
  }
}