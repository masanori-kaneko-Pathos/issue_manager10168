import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';

const DAY = 24 * 60 * 60 * 1000;
/** 既にあるものへの書きかけ（コメント・理由など）を残す日数 */
export const FIELD_DRAFT_DAYS = 7;
/** 書きかけの名札：「プロジェクト/課題/欄」（同じ課題・同じ欄なら、どの画面から開いても同じ書きかけが出る） */
export function fieldPlace(pid: string, iid: string, slot: string) {
  return `${pid}/${iid}/${slot}`;
}

/** 下書きの種類（新しく作るもの） */
export type DraftKind = 'issue' | 'project';

/** 新しく作るものの下書き。中身（data）の形は、使う画面が決める */
export interface Draft<T = unknown> {
  id: string;
  kind: DraftKind;
  title: string;        // 一覧に出す題名（空なら「（無題）」と出す）
  pid: string | null;   // 課題の下書きなら、どのプロジェクトか
  data: T;
  updatedAt: number;    // 最後に書いた時刻（ミリ秒）
}

interface FieldDraft { text: string; at: number; }

/**
 * 書きかけ。その端末のブラウザ（localStorage）に、人ごとに分けてしまう。
 * Firestore は使わない（打つたびに保存しても、読み書きと請求が増えないように）。別の端末には引き継がれない
 */
@Injectable({ providedIn: 'root' })
export class DraftService {
  private authService = inject(AuthService);
  private uid = computed(() => this.authService.user()?.uid ?? null);

  /** 新しく作るものの下書き（新しい順） */
  readonly drafts = signal<Draft[]>([]);
  readonly count = computed(() => this.drafts().length);

  constructor() {
    // ログインした人の下書きを読む（ログアウトしたら空。下書きそのものは消さない＝自分で残したものなので）
    effect(() => {
      const uid = this.uid();
      this.drafts.set(uid ? this.readDrafts(uid) : []);
    });
    // ほかのタブで下書きが増えた・消えたときも、件数をそろえる
    window.addEventListener('storage', (e) => {
      const uid = this.uid();
      if (uid && e.key === this.key('drafts', uid)) this.drafts.set(this.readDrafts(uid));
    });
  }

  // ---- 新しく作るものの下書き ----

  get(id: string) {
    return this.drafts().find((d) => d.id === id) ?? null;
  }

  /** しまう（同じ id があれば上書きして、一番上へ） */
  save(d: Omit<Draft, 'updatedAt'>) {
    const uid = this.uid();
    if (!uid) return;
    const next = [{ ...d, updatedAt: Date.now() }, ...this.drafts().filter((x) => x.id !== d.id)];
    this.drafts.set(next);
    this.write(this.key('drafts', uid), next);
  }

  remove(id: string) {
    const uid = this.uid();
    if (!uid || !this.get(id)) return;
    const next = this.drafts().filter((x) => x.id !== id);
    this.drafts.set(next);
    this.write(this.key('drafts', uid), next);
  }

  // ---- 既にあるものへの書きかけ（コメント・理由など。7日で消える） ----

  /** place は「どこの・どの欄か」の名札（例：comment:プロジェクトid:課題id） */
  getText(place: string): string {
    const all = this.readFields();
    const f = all?.[place];
    return f && Date.now() - f.at < FIELD_DRAFT_DAYS * DAY ? f.text : '';
  }

  /** しまう。空ならしまわずに消す */
  setText(place: string, text: string) {
    const uid = this.uid();
    if (!uid) return;
    const now = Date.now();
    // しまうついでに、7日を過ぎたものを掃除する
    const all = Object.fromEntries(Object.entries(this.readFields() ?? {})
      .filter(([k, f]) => k !== place && now - f.at < FIELD_DRAFT_DAYS * DAY));
    if (text.trim()) all[place] = { text, at: now };
    this.write(this.key('fields', uid), all);
  }

  clearText(place: string) {
    this.setText(place, '');
  }

  // ---- 道具 ----

  private key(kind: 'drafts' | 'fields', uid: string) {
    return `issuemanager.${kind}.${uid}`;
  }

  private readDrafts(uid: string): Draft[] {
    const list = this.read<Draft[]>(this.key('drafts', uid));
    return Array.isArray(list) ? [...list].sort((a, b) => b.updatedAt - a.updatedAt) : [];
  }

  private readFields(): Record<string, FieldDraft> | null {
    const uid = this.uid();
    return uid ? this.read<Record<string, FieldDraft>>(this.key('fields', uid)) : null;
  }

  /** 読めない・壊れているときは null（プライベートウィンドウなどで localStorage が使えないこともある） */
  private read<T>(k: string): T | null {
    try {
      const s = localStorage.getItem(k);
      return s ? (JSON.parse(s) as T) : null;
    } catch {
      return null;
    }
  }

  private write(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // 使えない・いっぱい：書きかけが残らないだけで、ほかの動きには響かない
    }
  }
}