import { Component, input, output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList } from '@angular/cdk/drag-drop';
import { Issue } from '../core/models';
import { TPipe } from '../i18n/i18n';

/**
 * ドラッグでゴミ箱へ（かんばん・カレンダー）。落とすと dropped で知らせるだけで、削除は呼ぶ側の窓で行う。
 * CDK は、つかんだ瞬間に落とせる箱とその位置を測るので、管理者の画面には常に置き、ふだんは透明にする。
 * 出し入れは透明度だけ（すべらせると、測った位置と見えている位置がずれる）
 */
@Component({
  selector: 'app-trash-drop',
  imports: [CdkDropList, TPipe],
  template: `
    <div class="zone" [class.show]="show()" cdkDropList [cdkDropListSortingDisabled]="true"
      [cdkDropListEnterPredicate]="accept" (cdkDropListDropped)="onDrop($event)" [attr.aria-hidden]="!show()">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
      <span>{{ 'trash.dropHere' | t }}</span>
    </div>
  `,
  styles: `
    .zone { position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
      z-index: 60; display: flex; align-items: center; justify-content: center; gap: 8px;
      min-width: 220px; height: 64px; padding: 0 24px; box-sizing: border-box;
      border: 2px dashed var(--danger); border-radius: 32px; background: var(--surface); color: var(--danger-text);
      font-size: 14px; font-weight: bold; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      opacity: 0; pointer-events: none; transition: opacity 150ms, background 150ms, color 150ms; }
    /* 見えているときだけ、マウスを受ける（CDK は「指の下の要素」で、箱の上かどうかを確かめるため） */
    .zone.show { opacity: 1; pointer-events: auto; }
    /* カードが上に乗っている間 */
    .zone.cdk-drop-list-dragging { background: var(--danger); color: var(--on-primary); border-style: solid; }
    /* 上に乗ると、CDK がカードの影を箱の中へ移す。箱がふくらまないように隠す */
    :host ::ng-deep .zone .cdk-drag-placeholder { display: none; }
  `,
})
export class TrashDrop {
  /** つかんでいる間だけ見せる */
  show = input(false);
  dropped = output<Issue>();

  /** 削除フォルダの中の課題は受けない（かんばん・カレンダーには出ないが、念のため） */
  readonly accept = (d: CdkDrag<Issue>) => d.data?.status !== 'deleted';

  onDrop(e: CdkDragDrop<unknown, unknown, Issue>) {
    if (e.previousContainer === e.container) return;
    this.dropped.emit(e.item.data);
  }
}