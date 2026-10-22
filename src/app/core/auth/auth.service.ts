import { Injectable, computed, inject, signal } from '@angular/core';
import {
  User, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut,
  sendEmailVerification, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  sendPasswordResetEmail, updateProfile as updateAuthProfile, // updateProfile（設定画面の保存）がすでにある
  reauthenticateWithPopup, verifyBeforeUpdateEmail,
} from 'firebase/auth';
import {
  collectionGroup, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch,
} from 'firebase/firestore';
import { auth, db, firebaseApp } from '../firebase';
import { I18nService } from '../../i18n/i18n';
import { ReminderBucket } from '../time/time';
import { DailyGroup, EmailGroup } from '../models';
import { PushService } from '../notification/push.service';


export interface UserProfile {
  displayName: string;
  email: string;
  timeZone: string;
  language: 'ja' | 'en';
  defaultView?: 'list' | 'board';
  dueReminders?: ReminderBucket[];  // 期限前の通知で数える区分
  dailyGroup?: DailyGroup;          // 毎朝のまとめの形（無ければ期限別）
  dailyTime?: number | 'off';       // 毎日のまとめの時刻（0時からの分・10分刻み。無ければ 10:00）。'off' は届けない
  introHidden?: boolean;            // 「ようこそ」の箱を「後で見る」で閉じた
  photoURL?: string | null;         // アイコンの写真（無い＝入れたことがない、null＝本人が外した）
  emailNotify?: EmailGroup[];       // メールで受け取る通知のまとまり（無い＝どれも受け取らない）
  pinnedProjects?: string[];        // 上に留めたプロジェクト（20件まで）
  projectOrder?: string[];          // プロジェクトの並び（ページでドラッグして並べた順。id の並び）
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  /** undefined = 確認中, null = 未ログイン */
  readonly user = signal<User | null | undefined>(undefined);
  readonly profile = signal<UserProfile | null>(null);
  private i18n = inject(I18nService);
  private push = inject(PushService);
  /** 新規登録で入力された表示名。ensureProfile が users を作るときに使う */
  private pendingName: string | null = null;

  constructor() {
    onAuthStateChanged(auth, async (u) => {
      if (u) {
        await this.ensureProfile(u);
        const p = (await getDoc(doc(db, 'users', u.uid))).data() as UserProfile;
        // メールアドレスを変えたあと、最初に開いたときに写しをそろえる（失敗しても、使うのに困らない）
        if (u.email && p.email !== u.email) {
          updateDoc(doc(db, 'users', u.uid), { email: u.email }).catch((e) => console.warn(e));
          p.email = u.email;
        }
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
  async signUpWithEmail(email: string, password: string, displayName: string) {
    this.pendingName = displayName;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateAuthProfile(cred.user, { displayName });
    this.useAppLanguage();
    await sendEmailVerification(cred.user, this.mailSettings());
  }

  /** パスワード再設定のメールを頼む。登録の有無は、呼び出し側に明かさない */
  async sendPasswordReset(email: string) {
    this.useAppLanguage();
    try {
      await sendPasswordResetEmail(auth, email, this.mailSettings());
    } catch (e) {
      // 登録のないメールアドレスでも、成功と同じに扱う
      if ((e as { code?: string }).code === 'auth/user-not-found') return;
      throw e;
    }
  }

  /** 確認メール・再設定メールの言語を、アプリの言語にそろえる */
  useAppLanguage() {
    auth.languageCode = this.i18n.lang();
  }

  /** メールのリンクの手続きが終わったあと、このアプリのログイン画面に戻す */
  private mailSettings() {
    return { url: `${location.origin}/login` };
  }
  async loginWithGoogle() {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }
  /** ログアウトの前に、この端末のプッシュの登録を消す（同じ端末で別の人がログインしたとき、前の人の通知が出ないように） */
  async logout() {
    await this.push.disable().catch(() => undefined);
    await signOut(auth);
  }

  private async ensureProfile(u: User) {
    const ref = doc(db, 'users', u.uid);
    if ((await getDoc(ref)).exists()) return;
    await setDoc(ref, {
      displayName: this.pendingName ?? u.displayName ?? u.email?.split('@')[0] ?? '',
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
  async updateProfile(
    changes: Partial<Pick<UserProfile,
    'displayName' | 'timeZone' | 'language' | 'defaultView' | 'dueReminders' | 'dailyGroup' | 'dailyTime'
    | 'introHidden' | 'photoURL' | 'emailNotify' | 'pinnedProjects' | 'projectOrder'>>,
  ) {
    const u = auth.currentUser!;
    await updateDoc(doc(db, 'users', u.uid), changes);
    this.profile.update((p) => (p ? { ...p, ...changes } : p));
    if (changes.language) this.i18n.lang.set(changes.language);

    // 表示名と写真は、所属する全プロジェクトのメンバーの写しにも書く（ほかの人の画面に出るのは、こちら）
    if (changes.displayName !== undefined || changes.photoURL !== undefined) {
      const s = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', u.uid)));
      if (!s.empty) {
        const copy = {
          ...(changes.displayName !== undefined ? { displayName: changes.displayName } : {}),
          ...(changes.photoURL !== undefined ? { photoURL: changes.photoURL } : {}),
        };
        const batch = writeBatch(db);
        s.docs.forEach((d) => batch.update(d.ref, copy));
        await batch.commit();
      }
    }
  }

  /** 自分のアイコンの写真：入れたもの（null＝外した）→ 入れたことがなければ Google の写真 */
  readonly myPhoto = computed(() => {
    const p = this.profile();
    return p && p.photoURL !== undefined ? p.photoURL : this.user()?.photoURL ?? null;
  });

  /** 写真を変える：切り取った画像を上げ、プロフィールとメンバーの写しに書き、前の写真を消す */
  async setPhoto(blob: Blob) {
    const u = auth.currentUser!;
    const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
    const st = getStorage(firebaseApp);
    const old = this.profile()?.photoURL;
    // 名前に時刻を入れる：同じ名前で上書きすると、ブラウザが前の写真を覚えていて、替わらないことがあるため
    const r = ref(st, `users/${u.uid}/avatar-${Date.now()}.jpg`);
    await uploadBytes(r, blob, { contentType: 'image/jpeg' });
    await this.updateProfile({ photoURL: await getDownloadURL(r) });
    await this.deleteOwnPhoto(old);
  }

  /** 写真を外す（頭文字の丸に戻す。Google の写真にも戻さない） */
  async removePhoto() {
    const old = this.profile()?.photoURL;
    await this.updateProfile({ photoURL: null });
    await this.deleteOwnPhoto(old);
  }

  /** 自分で上げた写真だけを消す（Google の写真は、こちらの倉庫のものではないので触らない） */
  private async deleteOwnPhoto(url: string | null | undefined) {
    if (!url || !url.includes('firebasestorage')) return;
    const { getStorage, ref, deleteObject } = await import('firebase/storage');
    await deleteObject(ref(getStorage(firebaseApp), url)).catch(() => undefined);
  }

  /** パスワード変更。安全のため、今のパスワードで本人確認してから変える */
  async changePassword(current: string, next: string) {
    const u = auth.currentUser!;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email!, current));
    await updatePassword(u, next);
  }

  /**
   * メールアドレスを変える。大事な操作なので、今のパスワードで本人確認してから。
   * 新しいアドレスに確認のリンクを送り、押されたときに初めて変わる（打ち間違えたアドレスに変わらないように）
   */
  async changeEmail(password: string, newEmail: string) {
    const u = auth.currentUser!;
    await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email!, password));
    this.useAppLanguage();
    await verifyBeforeUpdateEmail(u, newEmail, this.mailSettings());
  }

  /** 本人確認をし直す（アカウントの削除の前）。パスワードの人はパスワード、Google の人は Google の窓 */
  async reauthenticate(password: string) {
    const u = auth.currentUser!;
    if (this.isPasswordUser()) {
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email!, password));
    } else {
      await reauthenticateWithPopup(u, new GoogleAuthProvider());
    }
    // 関数は「ログインし直した時刻」を札で見るので、新しい札に取り替えておく
    await u.getIdToken(true);
  }

  /** アカウントを削除する（関数に頼む）。済んだら、この端末の下書きを消して、ログアウトする */
  async deleteAccount(handovers: Record<string, string>, reason: string) {
    const uid = auth.currentUser!.uid;
    const { getFunctions, httpsCallable } = await import('firebase/functions');
    await httpsCallable(getFunctions(firebaseApp, 'asia-northeast1'), 'imDeleteAccount')({ handovers, reason });
    // 下書き・書きかけは、この端末のブラウザにしかないので、ここで消す
    for (const k of ['drafts', 'fields']) {
      try { localStorage.removeItem(`issuemanager.${k}.${uid}`); } catch { /* 消せなくても害はない */ }
    }
    await this.logout();
  }

  /** 自分の表示名。設定で変えた名前（プロフィール）を正とし、まだ読めていなければ Auth の名前を使う */
  myName(user: User | null = auth.currentUser): string {
    return this.profile()?.displayName
      || user?.displayName || user?.email?.split('@')[0] || '';
  }
  /** メール/パスワードでログインしているか（Googleだけの人は false） */
  isPasswordUser(): boolean {
    return auth.currentUser?.providerData.some((p) => p.providerId === 'password') ?? false;
  }
}