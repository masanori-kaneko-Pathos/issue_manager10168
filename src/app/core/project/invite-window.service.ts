import { Injectable, signal } from '@angular/core';
import type { Invitee } from '../../shared/invite-picker';

/** 招待の窓に渡すもの：最初に選んでおくプロジェクト・最初から入れておく人・送れなかった人の送り直しか */
export interface InviteOpen { pid: string | null; initial: Invitee[]; retry: boolean; }

/**
 * 招待の窓（アプリに1つ。窓はヘッダーが置く）。ヘッダーの ＋ からも、メンバーのタブからも、ここに頼んで開く
 */
@Injectable({ providedIn: 'root' })
export class InviteWindow {
  readonly state = signal<InviteOpen | null>(null);
  /** 1人でも送れた回数（メンバーのタブが、増えたら招待中の一覧を読み直す） */
  readonly sentCount = signal(0);

  open(pid: string | null, initial: Invitee[] = [], retry = false) {
    this.state.set({ pid, initial, retry });
  }

  close() {
    this.state.set(null);
  }

  sent() {
    this.sentCount.update((n) => n + 1);
  }
}