import { Component, computed, model, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { auth } from '../core/firebase';
import { enterKey } from '../core/dom';
import { Role } from '../core/models';
import { TPipe } from '../i18n/i18n';

/** 招待する人と、その役割 */
export interface Invitee { email: string; role: Role; }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** アドレスの区切り：空白・改行・カンマ・セミコロン・読点 */
const SEP = /[\s,;、，；]+/;

/** 招待が送れなかった理由（翻訳キー） */
export function inviteErrorKey(e: unknown): string {
  return e instanceof Error && e.message === 'already-invited' ? 'invite.already' : 'invite.failed';
}

/**
 * 招待する人を選ぶ部品。足した人はまず「メンバー」に入り、ドラッグか ▾ で役割を変える。
 * まとめて貼り付けると、一度に全員が札になる
 */
@Component({
  selector: 'app-invite-picker',
  imports: [FormsModule, CdkDropListGroup, CdkDropList, CdkDrag, TPipe],
  template: `
    <div class="target" role="group" [attr.aria-label]="'invite.target' | t">
      <span class="target-label">{{ 'invite.target' | t }}</span>
      @for (r of roles; track r) {
        <button type="button" [class.on]="target() === r" [attr.aria-pressed]="target() === r"
          (click)="target.set(r)">{{ 'roles.' + r | t }}</button>
      }
    </div>
    <label class="field">{{ 'invite.email' | t }}
      <span class="email-row">
        <input type="text" name="inviteEmails" [(ngModel)]="text" autocomplete="off" inputmode="email"
          (keydown)="onKey($event)" (paste)="onPaste($event)" [placeholder]="'invite.emailPlaceholder' | t" />
        <button type="button" class="add" [disabled]="!text.trim()" (click)="flush()">{{ 'invite.add' | t }}</button>
      </span>
    </label>
    <p class="help">{{ 'invite.hint' | t }}</p>
    @if (error(); as err) { <p class="error" role="alert">{{ err.key | t: err.params }}</p> }

    <div class="cols" cdkDropListGroup>
      @for (r of roles; track r) {
        <section class="col" [attr.data-role]="r" cdkDropList [cdkDropListData]="r"
          [cdkDropListSortingDisabled]="true" (cdkDropListDropped)="onDrop($event)">
          <header>
            <strong>{{ 'roles.' + r | t }}</strong> <span class="count">{{ byRole()[r].length }}</span>
            @if (byRole()[r].length) {
              <span class="mv col-mv" [title]="'invite.moveAll' | t">▾
                <select [attr.aria-label]="'invite.moveAll' | t"
                  (change)="moveAll(r, $any($event.target).value); $any($event.target).value = ''">
                  <option value="" disabled selected>{{ 'invite.moveAll' | t }}</option>
                  @for (o of roles; track o) {
                    @if (o !== r) { <option [value]="o">{{ 'invite.moveTo' | t: { role: ('roles.' + o | t) } }}</option> }
                  }
                </select>
              </span>
            }
          </header>
          <p class="col-help">{{ 'roleHelp.' + r | t }}</p>
          <ul>
            @for (p of byRole()[r]; track p.email) {
              <li class="chip" cdkDrag [cdkDragData]="p" [cdkDragStartDelay]="{ touch: 300, mouse: 0 }"
                [class.bad]="!!failed()[p.email]">
                <span class="mail">{{ p.email }}</span>
                @if (failed()[p.email]; as why) { <span class="why">{{ why | t }}</span> }
                <span class="mv" aria-hidden="false">▾
                  <select [attr.aria-label]="'invite.changeRole' | t" (change)="setRole(p.email, $any($event.target).value)">
                    @for (o of roles; track o) {
                      <option [value]="o" [selected]="o === p.role">{{ 'roles.' + o | t }}</option>
                    }
                  </select>
                </span>
                <button type="button" class="rm" [attr.aria-label]="'invite.remove' | t: { email: p.email }"
                  (click)="remove(p.email)">✕</button>
              </li>
            } @empty {
              <li class="empty">{{ 'invite.dropHere' | t }}</li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 8px; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    .target { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .target-label { font-size: 14px; font-weight: bold; margin-right: 4px; }
    .target button { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-strong);
      background: var(--surface); border-radius: 18px; font-size: 13px; cursor: pointer; }
    .target button.on { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .col-mv { margin-left: auto; }
    .email-row { display: flex; gap: 8px; }
    .email-row input { flex: 1; min-width: 0; min-height: 44px; padding: 0 12px; font-size: 16px; font-weight: normal; }
    .add { min-height: 44px; padding: 0 14px; border: 1px solid var(--primary); border-radius: 8px;
      background: var(--surface); color: var(--primary); font-size: 14px; cursor: pointer; }
    .add:disabled { border-color: var(--border-strong); color: var(--text-disabled); cursor: default; }
    .help { margin: 0; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .error { margin: 0; color: var(--danger-text); font-size: 13px; overflow-wrap: anywhere; }
    .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .col { min-width: 0; padding: 8px; border-radius: 8px; background: var(--surface-alt);
      border-top: 3px solid var(--disabled); }
    .col[data-role='admin'] { border-top-color: var(--danger); }
    .col[data-role='member'] { border-top-color: var(--primary); }
    .col header { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .count { font-size: 12px; padding: 0 8px; border-radius: 10px; background: var(--surface); }
    .col-help { margin: 2px 0 6px; font-size: 11px; color: var(--text-muted); line-height: 1.4; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
    .chip { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 2px 4px 8px; border-radius: 8px;
      background: var(--surface); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); font-size: 13px; cursor: grab;
      -webkit-touch-callout: none; user-select: none; }
    .chip.bad { outline: 2px solid var(--danger); outline-offset: -2px; }
    .mail { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .why { flex-basis: 100%; font-size: 11px; color: var(--danger-text); }
    .mv { position: relative; width: 28px; height: 28px; display: inline-flex; align-items: center;
      justify-content: center; color: var(--text-muted); }
    .mv select { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .rm { width: 28px; height: 28px; border: none; background: none; color: var(--text-muted); cursor: pointer; }
    .empty { padding: 8px; border: 1px dashed var(--border-strong); border-radius: 8px; text-align: center;
      font-size: 12px; color: var(--text-subtle); }
    .cdk-drag-preview { box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); }
    .cdk-drag-placeholder { opacity: 0.3; }
    @media (max-width: 600px) {
      .cols { grid-template-columns: 1fr; }
    }
  `,
})
export class InvitePicker {
  /** 招待する人（親と双方向でつながる） */
  value = model<Invitee[]>([]);
  /** 送れなかった人と、その理由の翻訳キー */
  failed = input<Record<string, string>>({});

  /** 列の並び（権限の強い順。メンバーのタブの役割のメニューと同じ） */
  readonly roles: Role[] = ['admin', 'member', 'viewer'];
  private readonly myEmail = (auth.currentUser?.email ?? '').toLowerCase();

  text = '';
  /** 足した人を入れる列（貼る前に選んでおけば、20人でも1回で済む） */
  target = signal<Role>('member');
  error = signal<{ key: string; params?: Record<string, string> } | null>(null);

  byRole = computed(() => {
    const m: Record<Role, Invitee[]> = { admin: [], member: [], viewer: [] };
    for (const p of this.value()) m[p.role].push(p);
    return m;
  });

  /** Enter で札にする（変換を確定する Enter では足さない。フォームの送信もしない） */
  onKey(e: KeyboardEvent) {
    enterKey(e, () => this.flush());
  }

  /** 区切りのある貼り付けは、すぐ札にする（10人分をまとめて貼る場面のため） */
  onPaste(e: ClipboardEvent) {
    const pasted = (e.clipboardData?.getData('text') ?? '').trim();
    if (!SEP.test(pasted)) return; // 1件だけなら、ふつうに欄に入れる
    e.preventDefault();
    this.text = `${this.text} ${pasted}`.trim();
    this.flush();
  }

  /** 欄の文字を札にする。形の正しくないものは欄に残して知らせる。全部札にできたら true */
  flush(): boolean {
    const parts = this.text.split(SEP).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const have = new Set(this.value().map((p) => p.email));
    const add: Invitee[] = [];
    const bad: string[] = [];
    let self = false;
    for (const v of parts) {
      if (v === this.myEmail) { self = true; continue; }
      if (!EMAIL.test(v)) { bad.push(v); continue; }
      if (have.has(v)) continue;
      have.add(v);
      add.push({ email: v, role: this.target() });
    }
    if (add.length) this.value.update((list) => [...list, ...add]);
    this.text = bad.join(' ');
    this.error.set(bad.length ? { key: 'invite.badEmail', params: { emails: bad.join(', ') } }
      : self ? { key: 'invite.self' } : null);
    return bad.length === 0;
  }

  setRole(email: string, role: Role) {
    this.value.update((list) => list.map((p) => (p.email === email ? { ...p, role } : p)));
  }

  remove(email: string) {
    this.value.update((list) => list.filter((p) => p.email !== email));
  }


  /** 列の全員を、別の役割へまとめて移す（貼ってから役割の違いに気づいたとき用） */
  moveAll(from: Role, to: Role) {
    if (!to || from === to) return;
    this.value.update((list) => list.map((p) => (p.role === from ? { ...p, role: to } : p)));
  }

  onDrop(e: CdkDragDrop<Role, Role, Invitee>) {
    if (e.previousContainer !== e.container) this.setRole(e.item.data.email, e.container.data);
  }
}