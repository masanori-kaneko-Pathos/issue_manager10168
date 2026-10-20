import { Component, computed, effect, input, signal } from '@angular/core';

/** 写真がない人の丸の色（白い文字が読める濃さの6色。同じ人は、どの画面でも同じ色） */
const COLORS = ['#3b6fd8', '#2e8b57', '#c46a1a', '#c94040', '#7d4fc0', '#5f6b7a'];

/** uid から色を決める（文字の並びから数を作って、6で割った余り） */
function colorOf(key: string) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** 人のアイコン：写真があれば写真、なければ頭文字の丸。写真が読めなかったときも、頭文字に戻す */
@Component({
  selector: 'app-avatar',
  template: `
    @if (photo() && !broken()) {
      <img [src]="photo()" alt="" referrerpolicy="no-referrer" [style.width.px]="size()" [style.height.px]="size()"
        (error)="broken.set(true)" />
    } @else {
      <span class="initial" [style.width.px]="size()" [style.height.px]="size()"
        [style.font-size.px]="size() * 0.45" [style.background]="color()">{{ initial() }}</span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; vertical-align: middle; }
    img, .initial { display: block; border-radius: 50%; object-fit: cover; }
    .initial { display: flex; align-items: center; justify-content: center; color: #fff; font-weight: bold; line-height: 1; }
  `,
})
export class Avatar {
  name = input('');
  uid = input('');
  photo = input<string | null | undefined>(null);
  size = input(24);
  broken = signal(false);
  initial = computed(() => (this.name().trim()[0] ?? '?').toUpperCase());
  color = computed(() => colorOf(this.uid() || this.name()));

  constructor() {
    // 写真が替わったら、もう一度読んでみる
    effect(() => {
      this.photo();
      this.broken.set(false);
    });
  }
}