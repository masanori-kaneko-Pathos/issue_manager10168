import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { TPipe } from '../i18n/i18n';

/** 大きく見る画像（名前と URL） */
export interface ViewerImage { id: string; name: string; url: string; }

/**
 * 画像をその場で大きく見る窓。暗い幕の上に1枚。← → で前後の画像、Esc か幕を押すと閉じる。
 * 新しいタブを増やさずに、次々見られるように
 */
@Component({
  selector: 'app-image-viewer',
  imports: [TPipe],
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <div class="lb" role="dialog" aria-modal="true" [attr.aria-label]="cur().name" (click)="close.emit()">
      <img [src]="cur().url" [alt]="cur().name" (click)="$event.stopPropagation()" />
      @if (images().length > 1) {
        <button type="button" class="nav prev" [attr.aria-label]="'viewer.prev' | t"
          (click)="$event.stopPropagation(); move(-1)">‹</button>
        <button type="button" class="nav next" [attr.aria-label]="'viewer.next' | t"
          (click)="$event.stopPropagation(); move(1)">›</button>
      }
      <div class="bar" (click)="$event.stopPropagation()">
        <span class="nm">{{ cur().name }}
          @if (images().length > 1) { <span class="count">（{{ i() + 1 }} / {{ images().length }}）</span> }</span>
        <a [href]="cur().url" target="_blank" rel="noopener">{{ 'viewer.openTab' | t }}</a>
        <button type="button" class="x" [attr.aria-label]="'viewer.close' | t" (click)="close.emit()">✕</button>
      </div>
    </div>
  `,
  styles: `
    .lb { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.85); }
    img { max-width: 92vw; max-height: calc(100vh - 120px); object-fit: contain; border-radius: 4px;
      background: #fff; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }
    .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 64px; border: none;
      border-radius: 8px; background: rgba(255, 255, 255, 0.12); color: #fff; font-size: 32px; cursor: pointer; }
    .nav:hover { background: rgba(255, 255, 255, 0.25); }
    .prev { left: 12px; }
    .next { right: 12px; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 16px;
      padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); color: #fff; font-size: 14px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.6)); }
    .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { opacity: 0.7; }
    .bar a { color: #fff; white-space: nowrap; }
    .x { width: 40px; height: 40px; border: none; border-radius: 50%; background: rgba(255, 255, 255, 0.15);
      color: #fff; font-size: 18px; cursor: pointer; }
  `,
})
export class ImageViewer implements OnInit {
  images = input.required<ViewerImage[]>();
  /** 最初に見せる画像の番号 */
  start = input(0);
  close = output<void>();

  i = signal(0);
  cur = computed(() => this.images()[this.i()] ?? this.images()[0]);

  ngOnInit() {
    this.i.set(this.start());
  }

  /** 前後へ（端まで行ったら反対の端へ回る） */
  move(d: number) {
    const n = this.images().length;
    this.i.set((this.i() + d + n) % n);
  }

  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') this.close.emit();
    else if (e.key === 'ArrowLeft') this.move(-1);
    else if (e.key === 'ArrowRight') this.move(1);
  }
}