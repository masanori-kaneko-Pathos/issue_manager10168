/**
 * プルダウンに出す名前（長い名前は「…」で切る）。
 * ブラウザのプルダウンは中の見た目を変えられず、長い名前が欄や画面の外へはみ出すため
 */
export function shortName(name: string, max = 40) {
    return name.length > max ? name.slice(0, max) + '…' : name;
  }