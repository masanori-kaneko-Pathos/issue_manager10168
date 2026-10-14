// プッシュ通知の受け口。アプリを開いていないときに届いたものを出し、押されたらその画面を開く。
// 書き方（compat）と版は、リマインダーアプリで動いていたものに合わせている
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

// ※ src/environments/firebase-config.ts と同じ値にすること（特に appId）
firebase.initializeApp({
  apiKey: '…',
  authDomain: '…',
  projectId: 'kensyu10168',
  storageBucket: '…',
  messagingSenderId: '…',
  appId: '…',
});

const messaging = firebase.messaging();

// 画面を開いていないときのプッシュ（中身は、関数が data に入れた title・body・url）
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || '課題管理', {
    body: d.body || '',
    data: { url: d.url || '/' },
  });
});

// 押されたら、その画面を開く。アプリのタブがすでにあれば、それを前に出して移る
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((t) => t.url.startsWith(self.location.origin));
    if (tab) {
      await tab.focus();
      try {
        return await tab.navigate(url);
      } catch {
        // まだこのサービスワーカーの管理下にないタブは移れないので、新しく開く
      }
    }
    return clients.openWindow(url);
  })());
});