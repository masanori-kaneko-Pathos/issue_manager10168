import { Injectable, signal } from '@angular/core';
import { onRegistered, register } from 'firebase/messaging';
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, messagingIfSupported } from '../firebase';

/** Firebase プロジェクトの Web プッシュ証明書の鍵（リマインダーアプリと同じプロジェクトなので同じ鍵） */
const VAPID_KEY = 'BN-cUJ4130onI1BC_lymWbyx5_rIwqdhnNhy1BjQztVTgAnDqMBtokaswzJtC5OxK9phKPaj9vDRMZl0Mip3po8';
/** この端末で登録した ID の控え（「この端末で受け取っているか」を表示するため） */
const FID_KEY = 'issuemanager.pushFid';

/** unsupported＝使えない、blocked＝ブラウザでブロック中、off＝受け取っていない、on＝受け取っている */
export type PushState = 'unsupported' | 'blocked' | 'off' | 'on';

function readFid(): string | null {
  try {
    return localStorage.getItem(FID_KEY);
  } catch {
    return null;
  }
}
function writeFid(fid: string | null) {
  try {
    if (fid) localStorage.setItem(FID_KEY, fid);
    else localStorage.removeItem(FID_KEY);
  } catch {
    // 控えが残せなくても、受け取ること自体には響かない
  }
}

/** プッシュ通知：この端末の許可・登録・解除と、その状態 */
@Injectable({ providedIn: 'root' })
export class PushService {
  readonly state = signal<PushState>('off');

  /** 今の状態を調べる（設定画面を開いたとき） */
  async refresh() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !(await messagingIfSupported())) {
      this.state.set('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      this.state.set('blocked');
      return;
    }
    this.state.set(readFid() && Notification.permission === 'granted' ? 'on' : 'off');
  }

  /** この端末で受け取る：許可 → サービスワーカー → ID を受け取って、自分の端末として保存 */
  async enable() {
    const messaging = await messagingIfSupported();
    if (!messaging) {
      this.state.set('unsupported');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      this.state.set(permission === 'denied' ? 'blocked' : 'off');
      return;
    }
    await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    // ID は onRegistered に届く（リマインダーアプリと同じ手順）。15秒たっても来なければ失敗にする
    const fid = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('push-register-timeout')), 15000);
      onRegistered(messaging, (id) => {
        clearTimeout(timer);
        resolve(id);
      });
      register(messaging, { vapidKey: VAPID_KEY }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    await setDoc(doc(db, 'users', auth.currentUser!.uid, 'devices', fid), { fid, createdAt: serverTimestamp() });
    writeFid(fid);
    this.state.set('on');
  }

  /** この端末では受け取らない：自分の端末の文書を消す（関数は、文書のある端末にだけ送る） */
  async disable() {
    const uid = auth.currentUser?.uid;
    const fid = readFid();
    if (uid && fid) {
      await deleteDoc(doc(db, 'users', uid, 'devices', fid)).catch((e) => console.warn('端末の登録を消せませんでした', e));
    }
    writeFid(null);
    this.state.set('Notification' in window && Notification.permission === 'denied' ? 'blocked' : 'off');
  }
}