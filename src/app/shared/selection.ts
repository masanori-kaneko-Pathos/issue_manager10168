import { computed, signal } from '@angular/core';

/**
 * Gmail のような「選んで、まとめて操作」の選択。中身は id の集まりだけなので、
 * 課題・受信箱のメモ・お知らせなど、どの一覧でも使い回せる
 */
export class Selection {
  private ids = signal<ReadonlySet<string>>(new Set());
  readonly count = computed(() => this.ids().size);
  readonly any = computed(() => this.ids().size > 0);

  has(id: string) {
    return this.ids().has(id);
  }

  toggle(id: string) {
    this.ids.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 見えているものが全部選ばれているか */
  allOf(visible: string[]) {
    return visible.length > 0 && visible.every((id) => this.ids().has(id));
  }

  /** 見えているものが全部選ばれていれば外し、そうでなければ全部選ぶ */
  toggleAll(visible: string[]) {
    this.ids.set(this.allOf(visible) ? new Set() : new Set(visible));
  }

  /** 見えなくなったもの（絞り込みで外れた・消えた）を選択から外す。見えないものを操作しないため */
  keepOnly(visible: string[]) {
    const keep = new Set(visible);
    const cur = this.ids();
    if ([...cur].every((id) => keep.has(id))) return; // 変わらないなら、知らせを出さない
    this.ids.set(new Set([...cur].filter((id) => keep.has(id))));
  }

  clear() {
    this.ids.set(new Set());
  }
}