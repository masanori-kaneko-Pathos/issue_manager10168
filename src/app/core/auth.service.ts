import { Injectable, signal } from '@angular/core';
import {
  User, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

@Injectable({ providedIn: 'root' })
export class AuthService {
  /** undefined = 確認中, null = 未ログイン */
  readonly user = signal<User | null | undefined>(undefined);

  constructor() {
    onAuthStateChanged(auth, async (u) => {
      if (u) await this.ensureProfile(u);
      this.user.set(u);
    });
  }

  async loginWithEmail(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password);
  }
  async signUpWithEmail(email: string, password: string) {
    await createUserWithEmailAndPassword(auth, email, password);
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
}