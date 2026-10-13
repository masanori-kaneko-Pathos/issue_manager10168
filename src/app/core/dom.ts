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
/** 指で触る端末（スマホ・タブレット）か。Ctrl キーがないので、本文の Enter は改行にする */
export const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;

/**
 * Enter で保存するキー操作。日本語の変換を確定する Enter では保存しない。
 * multiline（本文）のときは、Shift＋Enter と Ctrl/⌘＋Enter で改行（スマホは Enter も改行）。
 * Ctrl＋Enter はブラウザが改行を入れないので、ここで入れて、新しい文字列を返す（それ以外は null）
 */
export function enterKey(e: KeyboardEvent, save: () => void, multiline = false): string | null {
  if (e.key !== 'Enter' || e.isComposing) return null;
  if (multiline && (IS_TOUCH || e.shiftKey)) return null; // 改行はブラウザに任せる
  e.preventDefault();
  if (multiline && (e.ctrlKey || e.metaKey)) {
    const t = e.target as HTMLTextAreaElement;
    const at = t.selectionStart;
    const next = t.value.slice(0, at) + '\n' + t.value.slice(t.selectionEnd);
    setTimeout(() => t.setSelectionRange(at + 1, at + 1));
    return next;
  }
  save();
  return null;
}