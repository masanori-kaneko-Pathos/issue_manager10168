import { ApplicationRef } from '@angular/core';

/**
 * 並びを変える処理を、ビュー遷移で包む（前と後の行の位置を、ブラウザがなめらかにつなぐ）。
 * 動かす行には、view-transition-name の名札を付けておくこと（画面の中で重ならない名前）。
 * 使えないブラウザと、動きを減らす設定の人には、動きなしで変えるだけ
 */
export function smoothly(appRef: ApplicationRef, change: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!d.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return;
  }
  // Angular はすぐには描き直さないので、この中で描き直しを頼む（頼まないと、ブラウザは「変わっていない」と見る）
  d.startViewTransition(() => {
    change();
    appRef.tick();
  });
}