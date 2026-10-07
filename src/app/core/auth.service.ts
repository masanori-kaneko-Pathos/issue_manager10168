import { Injectable, inject, signal } from '@angular/core';
import {
  User, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut,
  sendEmailVerification, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'firebase/auth';
import {
  collectionGroup, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { I18nService } from '../i18n/i18n';

export interface UserProfile {
  displayName: string;
  email: string;
  timeZone: string;
  language: 'ja' | 'en';
  defaultView?: 'list' | 'board';
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  /** undefined = 確認中, null = 未ログイン */
  readonly user = signal<User | null | undefined>(undefined);
  readonly profile = signal<UserProfile | null>(null);
  private i18n = inject(I18nService);

  constructor() {
    onAuthStateChanged(auth, async (u) => {
      if (u) {
        await this.ensureProfile(u);
        const p = (await getDoc(doc(db, 'users', u.uid))).data() as UserProfile;
        this.profile.set(p);
        this.i18n.lang.set(p.language);
      } else {
        this.profile.set(null);
      }
      this.user.set(u);
    });
  }

  async loginWithEmail(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password);
  }
  async signUpWithEmail(email: string, password: string) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(cred.user);
  }
  async loginWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }
  logout() {
    return signOut(auth);
  }

  private async ensureProfile(u: User) {
    const ref = doc(db, 'users', u.uid);
    if ((await getDoc(ref)).exists()) return;
    await setDoc(ref, {
      displayName: u.displayName ?? u.email?.split('@')[0] ?? '',
      email: u.email ?? '',
      timeZone: 'Asia/Tokyo',
      language: 'ja',
      createdAt: serverTimestamp(),
    });
  }
  /** 保存されているプロフィールを読み直す（設定画面を直接開いたとき用） */
  async fetchProfile(): Promise<UserProfile | null> {
    const u = auth.currentUser;
    if (!u) return null;
    const p = (await getDoc(doc(db, 'users', u.uid))).data() as UserProfile | undefined;
    if (p) this.profile.set(p);
    return p ?? null;
  }

  /** プロフィールの更新。表示名は、所属する全プロジェクトのメンバー情報の写しも書き換える */
  async updateProfile(changes: Partial<Pick<UserProfile, 'displayName' | 'timeZone' | 'language' | 'defaultView'>>) {
    const u = auth.currentUser!;
    await updateDoc(doc(db, 'users', u.uid), changes);
    this.profile.update((p) => (p ? { ...p, ...changes } : p));
    if (changes.language) this.i18n.lang.set(changes.language);

    if (changes.displayName !== undefined) {
      const s = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', u.uid)));
      if (!s.empty) {
        const batch = writeBatch(db);
        s.docs.forEach((d) => batch.update(d.ref, { displayName: changes.displayName }));
        await batch.commit();
      }
    }
  }

  /** パスワード変更。安全のため、今のパスワードで本人確認してから変える */
  async changePassword(current: string, next: string) {
    const u = auth.currentUser!;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email!, current));
    await updatePassword(u, next);
  }

  /** メール/パスワードでログインしているか（Googleだけの人は false） */
  isPasswordUser(): boolean {
    return auth.currentUser?.providerData.some((p) => p.providerId === 'password') ?? false;
  }
}