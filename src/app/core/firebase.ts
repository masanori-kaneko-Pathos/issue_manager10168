import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { firebaseConfig } from '../../environments/firebase-config';

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp, 'issuemanager');
import { Messaging, getMessaging, isSupported } from 'firebase/messaging';

/** プッシュ通知の窓口。使えないブラウザ（iPhone の Safari のタブなど）では null。最初に使うときに作る */
let messagingPromise: Promise<Messaging | null> | null = null;
export function messagingIfSupported(): Promise<Messaging | null> {
  messagingPromise ??= isSupported()
    .then((ok) => (ok ? getMessaging(firebaseApp) : null))
    .catch(() => null);
  return messagingPromise;
}