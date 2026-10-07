/** 指定した入力欄までスクロールして、入力できる状態にする。
 *  画面の読み込みが終わるまで、少し待ちながら何度か試す */
export function focusById(id: string, tries = 10) {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      return;
    }
    if (tries > 0) setTimeout(() => focusById(id, tries - 1), 200);
  }