import { Component, computed, input, output } from '@angular/core';
import { auth } from '../core/firebase';
import { Member } from '../core/models';
import { TPipe } from '../i18n/i18n';

/**
 * 担当者を選ぶプルダウン。自分を先頭に、あとは名前順。
 * 閲覧者や本人を外すのは、呼ぶ側で済ませてから渡す（場面ごとに外す人が違うため）
 */
@Component({
  selector: 'app-member-select',
  imports: [TPipe],
  template: `
    <select [attr.id]="selectId()" (change)="onChange($event)">
      @if (!found()) {
        <option value="" disabled selected>{{ placeholder() ? (placeholder()! | t) : '—' }}</option>
      }
      @for (m of sorted(); track m.uid) {
        <option [value]="m.uid" [selected]="value() === m.uid">
          {{ m.displayName }}{{ m.uid === myUid ? ('issueNew.you' | t) : '' }}</option>
      }
    </select>
  `,
  styles: `select { width: 100%; max-width: 360px; min-height: 44px; font-size: 16px; padding: 0 12px; }`,
})
export class MemberSelect {
  members = input.required<Member[]>();
  /** 今選ばれている人の uid（まだ選んでいなければ null） */
  value = input<string | null>(null);
  /** 選んでいないときに出す文の翻訳キー */
  placeholder = input<string | null>(null);
  /** 外の label と結ぶための id */
  selectId = input<string | null>(null);
  picked = output<string>();

  readonly myUid = auth.currentUser!.uid;
  sorted = computed(() => [...this.members()].sort((a, b) =>
    Number(b.uid === this.myUid) - Number(a.uid === this.myUid) || a.displayName.localeCompare(b.displayName)));
  /** 今の値が選択肢の中にあるか（ないときは、空の行を選んだ状態で出す） */
  found = computed(() => this.members().some((m) => m.uid === this.value()));

  onChange(e: Event) {
    const uid = (e.target as HTMLSelectElement).value;
    if (uid) this.picked.emit(uid);
  }
}