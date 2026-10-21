import {
    Component, DestroyRef, ElementRef, OnInit, inject, input, output, signal, viewChild,
  } from '@angular/core';
  import { TPipe } from '../i18n/i18n';
  
  /** 枠の大きさ（画面の上の px）と、仕上がりの大きさ（保存する px）と、拡大の上限 */
  const FRAME = 280;
  const OUT = 256;
  const MAX_ZOOM = 3;
  
  /**
   * アイコンにする範囲を選ぶ窓。丸い枠の奥で写真を動かし（ドラッグ）、近づける（つまみ・ホイール）。
   * 見せるのも切り取るのも、同じ写真（ImageBitmap）を同じ計算で描くので、見えていた範囲がそのまま上がる
   */
  @Component({
    selector: 'app-avatar-crop-dialog',
    imports: [TPipe],
    host: { '(document:keydown.escape)': 'cancel.emit()' },
    template: `
      <div class="backdrop" (click)="cancel.emit()"></div>
      <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="'crop.title' | t">
        <h2>{{ 'crop.title' | t }}</h2>
        @if (error()) {
          <p class="error" role="alert">{{ error() | t }}</p>
          <div class="row">
            <button type="button" class="link" (click)="cancel.emit()">{{ 'viewer.close' | t }}</button>
          </div>
        } @else {
          <div class="stage" [style.width.px]="frame" [style.height.px]="frame">
            <canvas #cv [style.width.px]="frame" [style.height.px]="frame"
              (pointerdown)="onDown($event)" (pointermove)="onMove($event)" (pointerup)="onUp($event)"
              (pointercancel)="onUp($event)" (wheel)="onWheel($event)"></canvas>
            <!-- 丸い枠：外側を暗くして、アイコンになる範囲だけ明るく見せる（押す・動かすは下の絵が受ける） -->
            <div class="mask" aria-hidden="true"></div>
          </div>
          <p class="help">{{ 'crop.help' | t }}</p>
          <label class="zoom">
            <span aria-hidden="true">−</span>
            <input type="range" min="1" [max]="maxZoom" step="0.01" [value]="zoom()"
              [attr.aria-label]="'crop.zoom' | t" (input)="setZoom(+$any($event.target).value)" />
            <span aria-hidden="true">＋</span>
          </label>
          <div class="row">
            <button type="button" class="link" (click)="cancel.emit()">{{ 'workflow.cancel' | t }}</button>
            <button type="button" class="primary" [disabled]="!ready()" (click)="confirm()">{{ 'crop.confirm' | t }}</button>
          </div>
        }
      </section>
    `,
    styles: `
      :host { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; }
      .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
      /* 写真の枠に合わせた小さな窓（スマホでも全画面にしない） */
      .dialog { width: min(340px, calc(100% - 32px)); height: auto; max-height: 90vh; border-radius: 12px; align-items: center; }
      h2 { align-self: flex-start; }
      .stage { position: relative; border-radius: 8px; overflow: hidden; background: #222; }
      canvas { display: block; touch-action: none; cursor: grab; }
      canvas:active { cursor: grabbing; }
      .mask { position: absolute; inset: 0; pointer-events: none; border-radius: 50%;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55); outline: 2px solid rgba(255, 255, 255, 0.9); }
      .help { text-align: center; }
      .zoom { display: flex; align-items: center; gap: 8px; width: 100%; color: var(--text-muted); }
      .zoom input { flex: 1; }
      .row { align-self: stretch; }
    `,
  })
  export class AvatarCropDialog implements OnInit {
    file = input.required<File>();
    /** 切り取った画像（256px の正方形の JPEG） */
    done = output<Blob>();
    cancel = output<void>();
  
    readonly frame = FRAME;
    readonly maxZoom = MAX_ZOOM;
    private cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');
    private bmp: ImageBitmap | null = null;
    /** 画面の細かさ（高精細の画面でも、枠の中の写真がぼやけないように） */
    private dpr = Math.max(1, window.devicePixelRatio || 1);
  
    ready = signal(false);
    error = signal('');
    zoom = signal(1);
    /** 写真の左上の位置（枠の左上から、画面の px） */
    private x = 0;
    private y = 0;
    /** つかんでいる指・マウス */
    private drag: { id: number; px: number; py: number } | null = null;
  
    constructor() {
      inject(DestroyRef).onDestroy(() => this.bmp?.close());
    }
  
    async ngOnInit() {
      try {
        // 写真の向き（スマホで縦に撮ったもの）を、写真の情報どおりに直して読む
        this.bmp = await createImageBitmap(this.file(), { imageOrientation: 'from-image' });
      } catch {
        this.error.set('settings.photoBad');
        return;
      }
      // 最初は、写真の短い辺が枠にぴったり（＝枠を埋める一番小さい大きさ）で、真ん中
      const s = this.scale();
      this.x = (FRAME - this.bmp.width * s) / 2;
      this.y = (FRAME - this.bmp.height * s) / 2;
      const c = this.cv()!.nativeElement;
      c.width = FRAME * this.dpr;
      c.height = FRAME * this.dpr;
      this.ready.set(true);
      this.draw();
    }
  
    /** 写真を何倍で描くか：短い辺が枠にぴったりの大きさ × 拡大 */
    private scale() {
      const b = this.bmp!;
      return (FRAME / Math.min(b.width, b.height)) * this.zoom();
    }
  
    /** 写真がいつも枠を埋めるように、位置を枠の中に収める（すき間ができる所には動かせない） */
    private clamp() {
      const s = this.scale();
      this.x = Math.min(0, Math.max(FRAME - this.bmp!.width * s, this.x));
      this.y = Math.min(0, Math.max(FRAME - this.bmp!.height * s, this.y));
    }
  
    private draw() {
      const c = this.cv()?.nativeElement;
      if (!c || !this.bmp) return;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, FRAME, FRAME);
      const s = this.scale();
      ctx.drawImage(this.bmp, this.x, this.y, this.bmp.width * s, this.bmp.height * s);
    }
  
    /** 拡大を変える。枠の真ん中に見えている所が、真ん中のまま動かないように */
    setZoom(z: number) {
      if (!this.bmp) return;
      const before = this.scale();
      const u = (FRAME / 2 - this.x) / before;  // 真ん中に見えている、写真の上の位置
      const v = (FRAME / 2 - this.y) / before;
      this.zoom.set(Math.min(MAX_ZOOM, Math.max(1, z)));
      const after = this.scale();
      this.x = FRAME / 2 - u * after;
      this.y = FRAME / 2 - v * after;
      this.clamp();
      this.draw();
    }
  
    onDown(e: PointerEvent) {
      if (!this.bmp) return;
      (e.target as Element).setPointerCapture(e.pointerId); // 枠の外まで動かしても、追いかけ続ける
      this.drag = { id: e.pointerId, px: e.clientX, py: e.clientY };
    }
  
    onMove(e: PointerEvent) {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.x += e.clientX - this.drag.px;
      this.y += e.clientY - this.drag.py;
      this.drag = { ...this.drag, px: e.clientX, py: e.clientY };
      this.clamp();
      this.draw();
    }
  
    onUp(e: PointerEvent) {
      if (this.drag?.id === e.pointerId) this.drag = null;
    }
  
    /** マウスのホイールで拡大（ページのスクロールにしない） */
    onWheel(e: WheelEvent) {
      e.preventDefault();
      this.setZoom(this.zoom() * Math.exp(-e.deltaY * 0.0015));
    }
  
    /**
     * 決める：枠の中に見えていた範囲を、写真の元の大きさに直して計算し、その範囲だけを 256px に描いて JPEG にする
     */
    async confirm() {
      if (!this.bmp) return;
      const s = this.scale();
      const sx = -this.x / s;
      const sy = -this.y / s;
      const size = FRAME / s;
      const out = document.createElement('canvas');
      out.width = OUT;
      out.height = OUT;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#fff'; // 透明の部分は白に（JPEG は透明を持てないため）
      ctx.fillRect(0, 0, OUT, OUT);
      ctx.drawImage(this.bmp, sx, sy, size, size, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/jpeg', 0.85));
      if (blob) this.done.emit(blob);
      else this.error.set('settings.photoBad');
    }
  }