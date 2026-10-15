import { Component, inject, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { auth } from '../core/firebase';
import { ProjectService } from '../core/project/project.service';
import { SearchService } from '../core/search/search.service';
import { InvitePicker, Invitee } from './invite-picker';
import { TPipe } from '../i18n/i18n';

/** プロジェクトの作成（名前だけで作れる。作るときに招待もできる） */
@Component({
  selector: 'app-project-new-dialog',
  imports: [FormsModule, TPipe, InvitePicker],
  host: { '(document:keydown.escape)': 'close.emit()' },
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <section class="dialog" [class.wide]="inviteOpen()" role="dialog" aria-modal="true"
      [attr.aria-label]="'projectNew.title' | t">
      <h2>{{ 'projectNew.title' | t }}</h2>
      <form (ngSubmit)="create()">
        <label class="field">{{ 'projectNew.name' | t }}
          <input name="name" [(ngModel)]="name" maxlength="100" autocomplete="off"
            [placeholder]="'projectNew.namePlaceholder' | t" />
        </label>

        <button type="button" class="toggle" [attr.aria-expanded]="inviteOpen()" (click)="inviteOpen.set(!inviteOpen())">
          {{ (inviteOpen() ? 'projectNew.hideInvite' : 'projectNew.showInvite') | t }}</button>
        @if (inviteOpen()) { <app-invite-picker [(value)]="invitees" /> }

        @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
        <div class="row">
          <button type="button" class="link" (click)="close.emit()">{{ 'workflow.cancel' | t }}</button>
          <button type="submit" class="primary" [disabled]="busy() || !name.trim()">{{ 'projectNew.submit' | t }}</button>
        </div>
      </form>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
    .dialog { position: relative; background: var(--surface); color: var(--text); width: min(480px, calc(100% - 32px));
      max-height: 90vh; overflow: auto; border-radius: 12px; padding: 16px; }
    .dialog.wide { width: min(720px, calc(100% - 32px)); }
    h2 { font-size: 18px; margin: 0 0 12px; }
    form { display: flex; flex-direction: column; gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; font-size: 14px; font-weight: bold; }
    input { min-height: 44px; padding: 0 12px; font-size: 16px; font-weight: normal; }
    .toggle { align-self: flex-start; min-height: 40px; padding: 0; border: none; background: none;
      color: var(--primary); font-size: 14px; cursor: pointer; }
    .error { margin: 0; color: var(--danger-text); }
    .row { display: flex; justify-content: flex-end; gap: 8px; }
    .link { background: none; border: none; color: var(--primary); min-height: 44px; cursor: pointer; }
    .primary { min-height: 44px; padding: 0 20px; background: var(--primary); color: var(--on-primary); border: none;
      border-radius: 8px; font-size: 14px; cursor: pointer; }
    .primary:disabled { background: var(--disabled); cursor: default; }
  `,
})
export class ProjectNewDialog {
  close = output<void>();

  private ps = inject(ProjectService);
  private search = inject(SearchService);
  private router = inject(Router);
  private picker = viewChild(InvitePicker);

  name = '';
  inviteOpen = signal(false);
  invitees = signal<Invitee[]>([]);
  busy = signal(false);
  error = signal('');

  /**
   * 作ってから、招待を送る。招待は作成と同じ保存にはできない
   * （招待のルールは「書く前の時点で管理者か」を見るので、作成の瞬間はまだ管理者ではない）
   */
  async create() {
    const name = this.name.trim();
    if (!name) return;
    // 欄に打ちかけのアドレスが残っていたら、札にしてから進む（形の違うものがあれば止まる）
    if (this.inviteOpen() && this.picker() && !this.picker()!.flush()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const user = auth.currentUser!;
      const pid = await this.ps.create(name, user);
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
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }
}