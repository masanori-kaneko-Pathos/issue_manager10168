import { Component, input, output } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/** 表かテキストの中身（読み込み中・読めなかった、も） */
export interface TextView {
  name: string;
  loading: boolean;
  failed?: boolean;
  rows?: string[][];   // CSV のとき（1行目は見出し）
  more?: number;       // 表示しきれなかった行の数
  text?: string;       // テキストのとき
}

/** CSV を表として、テキストをそのまま、その場で見る窓（大きく見る窓と同じ暗い幕） */
@Component({
  selector: 'app-text-viewer',
  imports: [TPipe],
  host: { '(document:keydown.escape)': 'close.emit()' },
  template: `
    <div class="lb" role="dialog" aria-modal="true" [attr.aria-label]="view().name" (click)="close.emit()">
      <section class="panel" (click)="$event.stopPropagation()">
        <header>
          <strong class="nm">{{ view().name }}</strong>
          <button type="button" class="x" [attr.aria-label]="'viewer.close' | t" (click)="close.emit()">✕</button>
        </header>
        <div class="body">
          @if (view().loading) {
            <p class="msg">{{ 'common.loading' | t }}</p>
          } @else if (view().failed) {
            <p class="msg error">{{ 'viewer.loadFailed' | t }}</p>
          } @else if (view().rows; as r) {
            <table>
              <thead><tr>@for (h of r[0]; track $index) { <th>{{ h }}</th> }</tr></thead>
              <tbody>
                @for (row of r.slice(1); track $index) {
                  <tr>@for (v of row; track $index) { <td>{{ v }}</td> }</tr>
                }
              </tbody>
            </table>
            @if (view().more) { <p class="msg">{{ 'viewer.more' | t: { n: '' + view().more } }}</p> }
          } @else {
            <pre>{{ view().text }}</pre>
          }
        </div>
      </section>
    </div>
  `,
  styles: `
    .lb { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.85); }
    .panel { display: flex; flex-direction: column; width: min(1100px, 94vw); max-height: 88vh; border-radius: 10px;
      background: var(--surface); overflow: hidden; }
    header { display: flex; align-items: center; gap: 12px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border); }
    .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { width: 36px; height: 36px; border: none; border-radius: 50%; background: none; font-size: 18px;
      color: var(--text-muted); cursor: pointer; }
    .x:hover { background: var(--surface-alt); }
    .body { overflow: auto; padding: 12px 16px; }
    table { border-collapse: collapse; font-size: 12px; }
    th, td { padding: 4px 8px; border: 1px solid var(--border); text-align: left; vertical-align: top;
      white-space: pre-wrap; max-width: 320px; overflow-wrap: anywhere; }
    th { position: sticky; top: -12px; background: var(--surface-alt); }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; }
    .msg { font-size: 13px; color: var(--text-muted); }
    .error { color: var(--danger-text); }
  `,
})
export class TextViewer {
  view = input.required<TextView>();
  close = output<void>();
}