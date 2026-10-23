import { Injectable, signal } from '@angular/core';

/** 下書きの窓を開いているか（アプリに1つ。ヘッダーの ＋・引き出し・?drafts=1 から開く） */
@Injectable({ providedIn: 'root' })
export class DraftsWindow {
  readonly open = signal(false);
}