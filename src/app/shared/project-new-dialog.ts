import { Component, DestroyRef, OnInit, inject, input, output, signal, viewChild } from '@angular/core';
import { DraftService } from '../core/draft/draft.service';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { auth } from '../core/firebase';
import { ProjectService } from '../core/project/project.service';
import { SearchService } from '../core/search/search.service';
import { InvitePicker, Invitee } from './invite-picker';
import { I18nService, TPipe } from '../i18n/i18n';
import { InviteConfirm } from './invite-confirm';
import { InboxService } from '../core/inbox/inbox.service';

/** プロジェクトの作成の下書きにしまう中身 */
interface ProjectDraft {
  name: string;
  inviteOpen: boolean;
  invitees: Invitee[];
  descOpen?: boolean;
  description?: string;
}

/** プロジェクトの作成（名前だけで作れる。作るときに招待もできる） */
@Component({
  selector: 'app-project-new-dialog',
  imports: [FormsModule, TPipe, InvitePicker, InviteConfirm],
  host: { '(document:keydown.escape)': 'close.emit()', '[animate.leave]': "'im-out-dialog'" },
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog narrow" [class.wide]="inviteOpen()" role="dialog" aria-modal="true"
      [attr.aria-label]="'projectNew.title' | t">
    <button type="button" class="dialog-x" [attr.aria-label]="'undo.close' | t" [title]="'undo.close' | t" (click)="(click)="cancel.emit()"">✕</button>
      <h2>{{ 'projectNew.title' | t }}</h2>
      @if (confirming()) {
        <!-- 招待する人がいるときだけ、作る前に確かめる（送ったものは取り消せないため） -->
        <app-invite-confirm [projectName]="name.trim()" [invitees]="invitees()" [busy]="busy()"
          okKey="invite.confirmCreate" (back)="confirming.set(false)" (ok)="create(true)" />
      } @else {
      <!-- 入力・選択・ボタンの操作は、どれも form まで上がってくるので、ここで1回だけ受けて下書きにしまう -->
      <form (ngSubmit)="create()" (input)="touch()" (change)="touch()" (click)="touch()">
        <label class="field">{{ 'projectNew.name' | t }}
          <input name="name" [(ngModel)]="name" maxlength="100" autocomplete="off"
            [placeholder]="'projectNew.namePlaceholder' | t" />
        </label>

        <button type="button" class="toggle" [attr.aria-expanded]="descOpen()" (click)="toggleDesc()">
          {{ (descOpen() ? 'projectNew.hideDesc' : 'projectNew.showDesc') | t }}</button>
        @if (descOpen()) {
          <label class="field">{{ 'overview.description' | t }}
            <textarea name="description" [(ngModel)]="description" rows="6" maxlength="5000"></textarea>
          </label>
        }

        <button type="button" class="toggle" [attr.aria-expanded]="inviteOpen()" (click)="inviteOpen.set(!inviteOpen())">
          {{ (inviteOpen() ? 'projectNew.hideInvite' : 'projectNew.showInvite') | t }}</button>
        @if (inviteOpen()) { <app-invite-picker [(value)]="invitees" /> }

        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        <div class="row">
          <button type="button" class="link" (click)="cancel()">{{ 'workflow.cancel' | t }}</button>
          <button type="submit" class="primary" [disabled]="busy() || !name.trim()">{{ 'projectNew.submit' | t }}</button>
        </div>
      </form>
      }
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    /* 招待を開いたら、3列の表が入るように広げる */
    .dialog.wide { width: min(720px, calc(100% - 32px)); }
    @media (max-width: 600px) { .dialog.wide { width: 100%; } }
    form { display: flex; flex-direction: column; gap: 12px; }
    input, textarea { font-weight: normal; }
    textarea { line-height: 1.6; }
    .toggle { align-self: flex-start; min-height: var(--tap); padding: 0; border: none; background: none;
      color: var(--primary); font-size: 14px; cursor: pointer; }
  `,
})
export class ProjectNewDialog implements OnInit {
  close = output<void>();
  /** 下書きから開いたときの、下書きの id（ヘッダーの＋から開いたときは null＝まっさら） */
  draftId = input<string | null>(null);
  private drafts = inject(DraftService);
  /** この窓の下書きの id（入力を受け取ってから決まるので、ngOnInit で入れる） */
  private id = '';
  /** 最後にしまった（または開いたときの）中身。変わっていなければ、しまわない */
  private lastSaved = '';
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  /** 作成できた・やめた（このあとは、もうしまわない） */
  private done = false;
  /** この回で何か触ったか（触っていなければ、閉じても「残しました」と知らせない） */
  private touched = false;
  /** 閉じたときの「下書きに残しました」を出す係（受信箱の知らせと同じ場所に出る） */
  private inbox = inject(InboxService);

  constructor() {
    // 閉じるとき（外を押した・Esc も）に、まだしまっていない分をしまう。書きかけが残ったら知らせる
    inject(DestroyRef).onDestroy(() => {
      this.flushDraft();
      if (this.touched && !this.done && this.drafts.get(this.id)) this.inbox.showFlash('drafts.saved');
    });
  }

  ngOnInit() {
    this.id = this.draftId() ?? crypto.randomUUID();
    const d = this.draftId() ? this.drafts.get(this.draftId()!) : null;
    if (d?.kind === 'project') {
      const v = d.data as ProjectDraft;
      this.name = v.name;
      this.inviteOpen.set(v.inviteOpen);
      this.invitees.set(v.invitees);
      this.descOpen.set(!!v.descOpen);
      this.description = v.description ?? '';
    }
    this.lastSaved = JSON.stringify(this.snapshot());
  }

  private snapshot(): ProjectDraft {
    return {
      name: this.name, inviteOpen: this.inviteOpen(), invitees: this.invitees(),
      descOpen: this.descOpen(), description: this.description,
    };
  }

  /** 何か触ったら、少し待ってから下書きにしまう */
  touch() {
    if (this.done) return;
    this.touched = true;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft(), 400);
  }

  /** 中身が変わっていたら、下書きにしまう。空なら下書きを消す（空の下書きをためない） */
  private flushDraft() {
    clearTimeout(this.draftTimer);
    if (this.done) return;
    const v = this.snapshot();
    const json = JSON.stringify(v);
    if (json === this.lastSaved) return;
    if (!v.name.trim() && !v.invitees.length && !this.descText()) this.drafts.remove(this.id);
    else this.drafts.save({ id: this.id, kind: 'project', title: v.name.trim(), pid: null, data: v });
    this.lastSaved = json;
  }

  /** やめる：自分で選んだので、下書きも捨てる（外を押した・Esc のときは残す） */
  cancel() {
    this.done = true;
    clearTimeout(this.draftTimer);
    this.drafts.remove(this.id);
    this.close.emit();
  }

  private ps = inject(ProjectService);
  private search = inject(SearchService);
  private router = inject(Router);
  private picker = viewChild(InvitePicker);

  name = '';
  descOpen = signal(false);
  description = '';
  private i18n = inject(I18nService);

  /** 説明の欄を開くと、雛形（【目的】【期間】【決まりごと】）が入る */
  toggleDesc() {
    if (!this.descOpen() && !this.description.trim()) this.description = this.i18n.t('overview.template');
    this.descOpen.set(!this.descOpen());
  }

  /** 保存する説明。雛形のまま何も書いていなければ空 */
  private descText() {
    const t = this.description.trim();
    return t === this.i18n.t('overview.template').trim() ? '' : t;
  }
  inviteOpen = signal(false);
  invitees = signal<Invitee[]>([]);
  busy = signal(false);
  error = signal('');

  /**
   * 作ってから、招待を送る。招待は作成と同じ保存にはできない
   * （招待のルールは「書く前の時点で管理者か」を見るので、作成の瞬間はまだ管理者ではない）
   */
  /** 作る前に、招待の確かめの画面を出しているか */
  confirming = signal(false);

  async create(confirmed = false) {
    const name = this.name.trim();
    if (!name) return;
    // 欄に打ちかけのアドレスが残っていたら、札にしてから進む（形の違うものがあれば止まる）
    if (this.inviteOpen() && this.picker() && !this.picker()!.flush()) return;
    // 招待する人がいれば、作る前に確かめの画面を出す
    if (!confirmed && this.inviteOpen() && this.invitees().length) {
      this.confirming.set(true);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const user = auth.currentUser!;
      const pid = await this.ps.create(name, user, { description: this.descOpen() ? this.descText() : '' });
      // 作れたので、下書きは要らない（このあと閉じても、しまい直さない）
      this.done = true;
      clearTimeout(this.draftTimer);
      this.drafts.remove(this.id);
      this.search.invalidate();
      const list = this.inviteOpen() ? this.invitees() : [];
      const failed: Invitee[] = [];
      if (list.length) {
        const project = (await this.ps.get(pid))!;
        const results = await Promise.allSettled(list.map((p) => this.ps.invite(project, p.email, p.role, user)));
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            console.error(r.reason);
            failed.push(list[i]);
          }
        });
      }
      this.close.emit();
      // 送れなかった人がいれば、メンバーのタブで招待のモーダルを、その人たちが入った状態で開く
      if (failed.length) {
        this.router.navigate(['/p', pid, 'members'], { state: { inviteFailed: failed } });
      } else {
        this.router.navigate(['/p', pid]);
      }
    } catch (e) {
      console.error(e);
      // 入力の画面に戻して、エラーを見せる（名前・招待する人はそのまま残っている）
      this.confirming.set(false);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}