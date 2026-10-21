import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Unsubscribe } from 'firebase/firestore';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ProjectNewDialog } from '../../shared/project-new-dialog';
import { SearchService } from '../../core/search/search.service';
import { sendEmailVerification } from 'firebase/auth';
import { auth } from '../../core/firebase';
import { AuthService } from '../../core/auth/auth.service';
import { ProjectService } from '../../core/project/project.service';
import { Invitation, Issue, Level, ProjectWithRole } from '../../core/models';
import { IssueService } from '../../core/issue/issue.service';
import { InboxService } from '../../core/inbox/inbox.service';
import { Clock } from '../../core/time/clock';
import { PriorityMark } from '../../shared/priority-mark';
import { compareIssues, isManualPriority, priorityOf } from '../../core/issue/priority';
import { DueBucket, dueBucket, remainingOf, shortDue } from '../../core/time/time';
import { I18nService, TPipe } from '../../i18n/i18n';
import { DeleteProjectDialog } from '../project/delete-project-dialog';
import { RequestService } from '../../core/request/request.service';
import { Router } from '@angular/router';
import { SampleService } from '../../core/project/sample.service';
import { MineBoard } from './mine-board';
import { MineCalendar } from './mine-calendar';
import { TabInk } from '../../shared/tab-ink';
import { MemoRow } from '../../shared/memo-row';
import { RecurMark } from '../../shared/recur-mark';

@Component({
  selector: 'app-home',
  imports: [RouterLink, TPipe, PriorityMark, ProjectNewDialog, DeleteProjectDialog,
    MineBoard, MineCalendar, TabInk, MemoRow, RecurMark],
  template: `
    <main>
      <!-- 知らせ・ようこそ・招待は、2列の上に全幅で -->
      @if (removedFrom() !== null) {
        <div class="notice" role="status">
          <p>{{ removedFrom()
            ? ('projects.removedNotice' | t: { project: removedFrom()! })
            : ('projects.removedNoticeUnknown' | t) }}</p>
          <button type="button" class="link" (click)="removedFrom.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (leftFrom() !== null) {
        <div class="notice" role="status">
          <p>{{ 'projects.leftNotice' | t: { project: leftFrom()! } }}</p>
          <button type="button" class="link" (click)="leftFrom.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (deletedProject(); as d) {
        <div class="notice" role="status">
          <p>{{ (d.byMe ? 'deleteProject.done' : 'deleteProject.gone') | t: { name: d.name } }}</p>
          <button type="button" class="link" (click)="deletedProject.set(null)">{{ 'projects.dismiss' | t }}</button>
        </div>
      }
      @if (needsVerify()) {
        <div class="notice">
          <p>{{ 'verify.message' | t }}</p>
          <button type="button" class="link" (click)="resendVerification()">{{ 'verify.resend' | t }}</button>
          <button type="button" class="link" (click)="checkVerified()">{{ 'verify.done' | t }}</button>
          @if (info()) { <p>{{ info() | t }}</p> }
        </div>
      }

      @if (showIntro()) {
        <section class="intro" [attr.aria-label]="'intro.title' | t">
          <h2>{{ 'intro.title' | t }}</h2>
          <p class="lead">{{ 'intro.lead' | t }}</p>
          <ol class="steps">
            <li>{{ 'intro.step1' | t }}</li>
            <li>{{ 'intro.step2' | t }}</li>
            <li>{{ 'intro.step3' | t }}</li>
          </ol>
          <div class="intro-actions">
            <button type="button" class="primary" [disabled]="sampleBusy()" (click)="trySample()">
              {{ (sampleBusy() ? 'intro.making' : 'intro.trySample') | t }}</button>
            <button type="button" class="ghost" [disabled]="sampleBusy()" (click)="newOpen.set(true)">
              {{ 'projectNew.title' | t }}</button>
            <button type="button" class="link" [disabled]="sampleBusy()" (click)="later()">{{ 'intro.later' | t }}</button>
          </div>
          <p class="small">{{ 'intro.laterHelp' | t }}</p>
        </section>
      }

      @if (invitations().length) {
        <section class="invites">
          <h2>{{ 'invitations.title' | t }}</h2>
          <ul class="list">
            @for (inv of invitations(); track inv.projectId) {
              <li class="invitation">
                <span class="name">{{ 'invitations.from' | t: {
                  name: inv.invitedByName, project: inv.projectName, role: i18n.t('roles.' + inv.role) } }}</span>
                <button type="button" class="primary" (click)="accept(inv)" [disabled]="busy()">{{ 'invitations.accept' | t }}</button>
                <button type="button" class="link" (click)="decline(inv)" [disabled]="busy()">{{ 'invitations.decline' | t }}</button>
              </li>
            }
          </ul>
        </section>
      }

      <div class="layout">
        <!-- 右（スマホでは先頭）：今日のまとめと、自分の課題 -->
        <section class="mine" id="today">
          <div class="head">
            <h2>{{ 'mine.title' | t }}</h2>
            <!-- プロジェクトのタブと同じ形（アイコン＋文字、今いるものに下線） -->
            <div class="views" role="tablist" [attr.aria-label]="'mine.title' | t">
              @for (v of viewList; track v) {
                <button type="button" role="tab" [class.on]="view() === v" [attr.aria-selected]="view() === v"
                  (click)="setView(v)">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="viewIcons[v]" /></svg>
                  {{ 'tabs.' + v | t }}</button>
              }
              <app-tab-ink />
            </div>
            @if (view() === 'list') {
              <label class="check">
                <input type="checkbox" [checked]="showDone()" (change)="showDone.set(!showDone())" />
                {{ 'mine.showDone' | t }}
              </label>
            }
          </div>
          @if (view() === 'board') {
            <app-mine-board [issues]="openMine()" [nameOf]="nameFn" />
          } @else if (view() === 'calendar') {
            <app-mine-calendar [issues]="openMine()" [nameOf]="nameFn" />
          } @else {
          <div class="today" role="group" [attr.aria-label]="'today.title' | t">
            <span class="today-title">{{ 'today.title' | t }}</span>
            @for (b of buckets; track b) {
              <!-- 押すと、下のその見出しへ飛ぶ -->
              <button type="button" class="t-chip" [attr.data-b]="b" [disabled]="!todayCounts()[b]" (click)="jump(b)">
                @if (b === 'overdue') { <span class="bang" aria-hidden="true">!</span> }
                {{ 'today.buckets.' + b | t }} <strong>{{ todayCounts()[b] }}</strong>
              </button>
            }
            @if (oldMemos()) {
              <a routerLink="/inbox" class="t-chip">{{ 'today.oldMemos' | t }} <strong>{{ oldMemos() }}</strong></a>
            }
            @if (!hasToday()) { <span class="small">{{ 'today.none' | t }}</span> }
          </div>

          @for (s of sections(); track s.key) {
            @let closed = folded().has(s.key);
            <h3 class="sec" [id]="'sec-' + s.key" [attr.data-k]="s.key">
              <button type="button" class="fold" [attr.aria-expanded]="!closed" (click)="toggleFold(s.key)">
                <span class="tri" [class.shut]="closed" aria-hidden="true">▾</span>
                {{ s.label | t }}<span class="n">{{ s.items.length }}</span></button></h3>
            @if (!closed) {
            <ul class="ilist reveal">
              @for (i of s.items; track i.id) {
                <li>
                  @if (isActive(i)) {
                    <app-priority-mark [level]="prio(i)" [manual]="manual(i)" />
                  } @else {
                    <span class="prio-none"></span>
                  }
                  <a class="ititle" [routerLink]="['/p', i.projectId, 'i', i.id]">
                    <span class="num">#{{ i.number }}</span> @if (i.recurringId) { <app-recur-mark [size]="11" /> } {{ i.title }}</a>
                  <span class="iproj">{{ projectName(i.projectId) }}</span>
                  @if (isActive(i)) {
                    <span class="idue" [class.overdue]="isOverdue(i)" [title]="remaining(i)">{{ dueLabel(i) }}</span>
                  } @else {
                    <span class="idue">{{ 'status.' + i.status | t }}</span>
                  }
                </li>
              }
            </ul>
            }
          } @empty {
            <p class="empty">{{ 'mine.empty' | t }}</p>
          }

          @if (mySubtaskIssues().length) {
            <h3 class="sec">{{ 'mine.subtasks' | t: { n: '' + mySubtaskIssues().length } }}</h3>
            <ul class="ilist">
              @for (i of mySubtaskIssues(); track i.id) {
                <li>
                  <span class="prio-none"></span>
                  <a class="ititle" [routerLink]="['/p', i.projectId, 'i', i.id]">
                    <span class="num">#{{ i.number }}</span> @if (i.recurringId) { <app-recur-mark [size]="11" /> } {{ i.title }}</a>
                  <span class="iproj">{{ projectName(i.projectId) }}</span>
                </li>
              }
            </ul>
          }
          }
        </section>

        <!-- 左（スマホでは後ろ）：プロジェクトと、受信箱 -->
        <aside class="side">
          <section class="box">
            <div class="side-head">
              <h2>{{ 'projects.title' | t }}</h2>
              <button type="button" class="icon-btn" [attr.aria-label]="'projectNew.title' | t" [title]="'projectNew.title' | t"
                (click)="newOpen.set(true)">＋</button>
            </div>
            @if (error()) { <p class="error" role="alert">{{ error() | t }}</p> }
            @if (loading()) {
              <p class="small">{{ 'common.loading' | t }}</p>
            } @else {
              <ul class="plist">
                @for (p of activeProjects(); track p.id) {
                  <li>
                    <a class="pname" [routerLink]="['/p', p.id]" [title]="p.name">{{ p.name }}</a>
                    @if (reqCount()[p.id]; as n) {
                      <a class="req-chip" [routerLink]="['/p', p.id, 'requests']" [title]="'request.waiting' | t">
                        {{ 'request.homeChip' | t: { n: '' + n } }}</a>
                    }
                    <span class="role">{{ 'roles.' + p.role | t }}</span>
                  </li>
                } @empty {
                  <li class="first">
                    <span class="small">{{ 'projects.empty' | t }}</span>
                    <button type="button" class="primary" (click)="newOpen.set(true)">{{ 'projectNew.title' | t }}</button>
                  </li>
                }
              </ul>
              @if (archivedProjects().length) {
                <button type="button" class="link fold-btn" [attr.aria-expanded]="showArchived()"
                  (click)="showArchived.set(!showArchived())">
                  {{ 'archive.section' | t: { n: '' + archivedProjects().length } }}
                  <span class="tri" [class.up]="showArchived()" aria-hidden="true">▾</span></button>
                @if (showArchived()) {
                  <ul class="plist reveal">
                    @for (p of archivedProjects(); track p.id) {
                      <li class="archived">
                        <a class="pname" [routerLink]="['/p', p.id]" [title]="p.name">{{ p.name }}</a>
                        <span class="role">{{ 'archive.kinds.' + (p.archiveKind ?? 'completed') | t }}</span>
                        @if (p.role === 'admin') {
                          <div class="row-more">
                            <button type="button" class="row-more-btn" [attr.aria-expanded]="rowMenu() === p.id"
                              [attr.aria-label]="'project.menu' | t" [title]="'project.menu' | t"
                              (click)="toggleRowMenu(p.id, $event)">⋮</button>
                            @if (rowMenu() === p.id) {
                              <div class="backdrop" (click)="rowMenu.set(null)"></div>
                              <div class="menu" role="menu" [class.up]="rowMenuUp()">
                                <button type="button" role="menuitem" [disabled]="busy()" (click)="unarchive(p)">
                                  {{ 'archive.unarchive' | t }}</button>
                                <div class="sep" role="separator"></div>
                                <button type="button" role="menuitem" class="danger"
                                  (click)="rowMenu.set(null); deleteTarget.set(p)">{{ 'deleteProject.open' | t }}</button>
                              </div>
                            }
                          </div>
                        }
                      </li>
                    }
                  </ul>
                }
              }
            }
          </section>

          <section class="box">
            <div class="side-head">
              <h2><a routerLink="/inbox" class="h-link">{{ 'inbox.title' | t }}</a>
                @if (inbox.count()) { <span class="n">{{ inbox.count() }}</span> }</h2>
              <button type="button" class="icon-btn" [attr.aria-label]="'inbox.write' | t" [title]="'inbox.write' | t"
                (click)="inbox.openPen()">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg></button>
            </div>
            <ul class="mlist">
              @for (m of inbox.active().slice(0, 3); track m.id) {
                <!-- ペンの吹き出しと同じ1行（押すとその場で直す・課題にする・ゴミ箱へ） -->
                <li><app-memo-row [memo]="m" [compact]="true" touchUi="menu" /></li>
              } @empty {
                <li class="small">{{ 'inbox.empty' | t }}</li>
              }
            </ul>
          </section>
        </aside>
      </div>
    </main>
    @if (newOpen()) { <app-project-new-dialog (close)="newOpen.set(false)" /> }
    @if (deleteTarget(); as p) {
      <app-delete-project-dialog [pid]="p.id" [name]="p.name" [prefill]="!!p.sample" (done)="onDeleted($event)"
        (cancel)="deleteTarget.set(null)" />
    }
  `,
  styles: `
    main { max-width: 1200px; margin: 0 auto; padding: 16px 16px 48px; box-sizing: border-box; }
    h2 { font-size: 16px; margin: 0; }
    .small { font-size: 12px; color: var(--text-muted); }
    .empty { margin: 12px 0; color: var(--text-muted); font-size: 14px; }
    .notice { background: var(--warning-bg); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
    .notice p { margin: 0 0 8px; }

    /* ようこその箱・招待（全幅） */
    .intro { margin-bottom: 24px; padding: 16px; border-radius: 12px; border: 1px solid var(--primary);
      background: var(--primary-bg); }
    .intro h2 { margin: 0 0 6px; }
    .intro .lead { margin: 0 0 8px; }
    .steps { margin: 0 0 12px; padding-left: 1.4em; display: flex; flex-direction: column; gap: 4px; font-size: 14px; }
    .intro-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .invites { margin-bottom: 24px; }
    .list { list-style: none; padding: 0; margin: 8px 0 0; }
    .invitation { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px;
      border-bottom: 1px solid var(--border); }
    .invitation .name { flex-basis: 100%; }

    /* 2列：左にプロジェクトと受信箱（細い）、右に自分の課題（広い）。スマホは書いた順の1列 */
    .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); grid-template-areas: 'side mine';
      gap: 32px; align-items: start; }
    .mine { grid-area: mine; min-width: 0; scroll-margin-top: 64px; }
    .side { grid-area: side; display: flex; flex-direction: column; gap: 16px; position: sticky; top: 68px; }
    @media (max-width: 959px) {
      .layout { grid-template-columns: minmax(0, 1fr); grid-template-areas: none; gap: 24px; }
      .mine, .side { grid-area: auto; }
      .side { position: static; }
    }

    /* 左の箱（プロジェクト・受信箱） */
    .box { padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
    .side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .side-head h2 { display: flex; align-items: center; gap: 6px; font-size: 14px; }
    .h-link { color: var(--text); text-decoration: none; }
    .h-link:hover { text-decoration: underline; }
    .n { font-size: 12px; font-weight: normal; padding: 0 8px; border-radius: 10px; background: var(--surface-alt);
      color: var(--text-muted); }
    .icon-btn { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; padding: 0;
      border: none; border-radius: 6px; background: none; color: var(--text-muted); font-size: 18px; cursor: pointer; }
    .icon-btn:hover { background: var(--surface-alt); color: var(--text); }
    .plist, .mlist { list-style: none; margin: 0; padding: 0; }
    .plist li { display: flex; align-items: center; gap: 6px; min-height: 34px; }
    .mlist li { display: flex; align-items: center; }
    .pname, .mname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 4px 6px; margin: 0 -6px; border-radius: 6px; color: var(--text); text-decoration: none; font-size: 14px; }
    .pname:hover, .mname:hover { background: var(--surface-alt); }
    .mname { font-size: 13px; }
    .role { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--chip-bg); }
    .archived .pname { color: var(--text-subtle); }
    .first { flex-direction: column; align-items: flex-start !important; gap: 8px; padding: 4px 0; }
    .req-chip { flex: none; font-size: 11px; padding: 1px 8px; border-radius: 10px; text-decoration: none; white-space: nowrap;
      background: var(--warning-bg); color: var(--warning-text); border: 1px solid var(--warning-border); }
    .old { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--warning-bg); color: var(--warning-text); }
    .fold-btn { gap: 4px; min-height: 32px; font-size: 13px; }

    /* アーカイブ済みの行の ⋮ */
    .row-more { position: relative; flex: none; }
    .row-more-btn { width: 28px; height: 28px; border: none; border-radius: 50%; background: none;
      color: var(--text-muted); font-size: 16px; cursor: pointer; }
    .row-more-btn:hover { background: var(--surface-alt); }
    .backdrop { position: fixed; inset: 0; z-index: 51; }
    .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 52; min-width: 220px;
      background: var(--surface); border-radius: 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      padding: 6px 0; display: flex; flex-direction: column; }
    .menu button { text-align: left; padding: 0 16px; min-height: 44px; background: none; border: none;
      color: var(--text); font-size: 14px; cursor: pointer; }
    .menu button:hover:not(:disabled) { background: var(--surface-alt); }
    .menu .sep { height: 1px; margin: 6px 0; background: var(--border); }
    .menu button.danger { color: var(--danger-text); font-weight: bold; }
    .menu button.danger:hover { background: var(--danger-bg); }
    .menu.up { top: auto; bottom: calc(100% + 4px); }

    /* 自分の課題 */
    .head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; }
    .check { display: flex; align-items: center; gap: 6px; font-size: 13px; min-height: 36px; }
    .today { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 4px; }
    .today-title { font-size: 12px; color: var(--text-muted); margin-right: 4px; }
    .t-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 16px; background: var(--surface); color: var(--text);
      font-size: 13px; text-decoration: none; cursor: pointer; }
    .t-chip:hover:not(:disabled) { background: var(--surface-alt); }
    .t-chip strong { font-size: 14px; }
    .t-chip:disabled { color: var(--text-disabled); cursor: default; }
    .t-chip[data-b='overdue']:not(:disabled) .bang,
    .t-chip[data-b='overdue']:not(:disabled) strong { color: var(--danger-text); }
    .bang { font-weight: bold; }
    /* 期限の見出し。飛んだとき、アプリのヘッダーの下に隠れないように */
    .sec { display: flex; align-items: center; gap: 6px; margin: 18px 0 4px; font-size: 13px; color: var(--text-muted);
      scroll-margin-top: 64px; }
    .sec[data-k='overdue'] { color: var(--danger-text); }
    .ilist { list-style: none; margin: 0; padding: 0; }
    .ilist li { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 2px 8px;
      border-bottom: 1px solid var(--border); }
    .ilist li:hover { background: var(--surface-alt); }
    .ilist app-priority-mark, .prio-none { width: 18px; flex: none; }
    .ititle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--text); text-decoration: none; font-size: 14px; }
    .ititle:hover { text-decoration: underline; }
    .num { color: var(--text-muted); font-size: 13px; }
    .iproj { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; color: var(--text-muted); }
    .idue { flex: none; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .idue.overdue { color: var(--danger-text); font-weight: bold; }
    /* リスト｜かんばん｜カレンダー：プロジェクトのタブと同じ見た目 */
    .views { position: relative; display: inline-flex; gap: 2px; margin-right: auto; border-bottom: 1px solid var(--border); }
    /* 下の線（1px）の上に重ねる */
    .views app-tab-ink { bottom: -1px; }
    .views button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px;
      border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; background: none;
      color: var(--text-muted); font-size: 14px; cursor: pointer; }
    .views button:hover { color: var(--text); }
    .views button.on { color: var(--text); font-weight: bold; }
    .views button.on svg { color: var(--primary); }
    /* 期限の見出し：押すと、その区切りをたたむ・開く */
    .fold { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px; margin-left: -4px; border: none;
      border-radius: 6px; background: none; color: inherit; font: inherit; cursor: pointer; }
    .fold:hover { background: var(--surface-alt); }
    /* 三角は1つの絵を回す（たたむと左向き、アーカイブを開くと上向き） */
    .tri { display: inline-block; width: 12px; font-size: 11px; text-align: center; transition: rotate 160ms var(--ease-out); }
    .tri.shut { rotate: -90deg; }
    .tri.up { rotate: 180deg; }
    @media (max-width: 600px) {
      .iproj { display: none; }
    }
    `,
})
export class Projects implements OnInit {
  private authService = inject(AuthService);
  private projectService = inject(ProjectService);
  private issueService = inject(IssueService);
  private clock = inject(Clock);
  private tz = computed(() => this.authService.profile()?.timeZone ?? 'Asia/Tokyo');
  protected i18n = inject(I18nService);
  private route = inject(ActivatedRoute);
  protected inbox = inject(InboxService);
  /** 自分の課題の見せ方（URL の ?view= に残す。戻る・再読み込みで同じ表示に） */
  readonly viewList = ['list', 'board', 'calendar'] as const;
  /** 切り替えのアイコン（プロジェクトのタブと同じ絵） */
  readonly viewIcons: Record<string, string> = {
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    board: 'M3 4h5v16H3zM10 4h4v10h-4zM16 4h5v13h-5z',
    calendar: 'M3 6h18v15H3zM3 10h18M8 3v4M16 3v4',
  };
  view = signal<'list' | 'board' | 'calendar'>((() => {
    const v = this.route.snapshot.queryParamMap.get('view');
    return v === 'board' || v === 'calendar' ? v : 'list';
  })());

  setView(v: 'list' | 'board' | 'calendar') {
    this.view.set(v);
    this.router.navigate([], {
      relativeTo: this.route, queryParams: { view: v === 'list' ? null : v },
      queryParamsHandling: 'merge', replaceUrl: true
    });
  }

  /** かんばん・カレンダーに出す課題：未完了と解決済み（アーカイブ中・削除フォルダの中は除く） */
  openMine = computed(() => this.myIssues().filter((i) => !this.archivedIds().has(i.projectId)
    && ['open', 'in_progress', 'on_hold', 'resolved'].includes(i.status)));
  /** 部品にプロジェクト名の引き方を渡す（テンプレートでは矢印関数が書けないので、ここで作る） */
  readonly nameFn = (pid: string) => this.projectName(pid);

  /** 「自分の課題」の見張り。プロジェクトごとに1本（pid → やめる関数） */
  private mineStops = new Map<string, Unsubscribe>();
  /** 読めなくなったプロジェクト（同じプロジェクトに何度も張り直さないための印） */
  private mineFailed = new Set<string>();
  /** プロジェクトごとの、自分が担当の課題（pid → 課題） */
  private mineByProject = signal<Record<string, (Issue & { projectId: string })[]>>({});
  private stopInvitations: Unsubscribe | null = null;
  private requests = inject(RequestService);
  /** 管理者のプロジェクトごとの、対応待ちの依頼の見張り（pid → やめる関数） */
  private reqStops = new Map<string, Unsubscribe>();
  /** プロジェクトごとの、対応待ちの依頼の数 */
  reqCount = signal<Record<string, number>>({});

  constructor() {

    // 朝のまとめの通知から来たら、今日のまとめの欄まで動かす
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((f) => {
      if (f === 'today') setTimeout(() => document.getElementById('today')?.scrollIntoView({ block: 'start' }));
    });
    // ホームを離れたら、見張りをやめる
    inject(DestroyRef).onDestroy(() => {
      this.mineStops.forEach((stop) => stop());
      this.reqStops.forEach((stop) => stop());
      this.stopInvitations?.();
    });
  }

  projects = signal<ProjectWithRole[]>([]);
  /** 進行中のプロジェクトと、アーカイブ済みのプロジェクト（アーカイブ済みは下にたたむ） */
  activeProjects = computed(() => this.projects().filter((p) => !p.archived));
  archivedProjects = computed(() => this.projects().filter((p) => p.archived));
  showArchived = signal(false);
  /** アーカイブ済みの行の ⋮（開いているプロジェクトの id） */
  rowMenu = signal<string | null>(null);
  /** メニューを上に開くか（ボタンが画面の下のほうにあって、下に開くと切れるとき） */
  rowMenuUp = signal(false);

  toggleRowMenu(pid: string, e: MouseEvent) {
    if (this.rowMenu() === pid) {
      this.rowMenu.set(null);
      return;
    }
    // ボタンの下に、メニュー（約140px）が収まる空きがあるか
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.rowMenuUp.set(window.innerHeight - r.bottom < 160);
    this.rowMenu.set(pid);
  }
  /** 削除のモーダルを開いているプロジェクト */
  deleteTarget = signal<ProjectWithRole | null>(null);

  /** アーカイブの解除（ホームから）。済んだら一覧を読み直す */
  async unarchive(p: ProjectWithRole) {
    this.rowMenu.set(null);
    this.busy.set(true);
    try {
      await this.projectService.unarchive(p.id, auth.currentUser!.uid, p.role);
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  /** 削除し終わった（ホームにいるので移動はせず、知らせを出して一覧を読み直す） */
  async onDeleted(name: string) {
    this.deleteTarget.set(null);
    this.deletedProject.set({ name, byMe: true });
    await this.load();
  }
  invitations = signal<Invitation[]>([]);
  /** 見張りで届いた課題（担当が自分か、サブタスクの担当が自分） */
  private watchedMine = computed(() => Object.values(this.mineByProject()).flat());
  /** 自分が担当の課題（「自分の課題」と今日のまとめは、こちらだけを数える） */
  myIssues = computed(() => this.watchedMine().filter((i) => i.assigneeId === auth.currentUser!.uid));
  /** サブタスクだけ担当している、未完了の課題（親の担当も自分なら、上に出ているので除く・赤J） */
  mySubtaskIssues = computed(() => {
    const uid = auth.currentUser!.uid;
    return this.watchedMine()
      .filter((i) => i.assigneeId !== uid && this.isActive(i) && !this.archivedIds().has(i.projectId))
      .sort((a, b) => compareIssues(a, b, this.clock.now()));
  });
  showDone = signal(false);
  readonly buckets: DueBucket[] = ['overdue', 'today', 'tomorrow', 'in3'];
  /** アーカイブ中のプロジェクト（今日のまとめには数えない） */
  private archivedIds = computed(() => new Set(this.projects().filter((p) => p.archived).map((p) => p.id)));
  /** 今日のまとめで数える課題か：未完了（未着手・対応中・保留）で、アーカイブ中でないプロジェクトのもの */
  private counts = (i: Issue & { projectId: string }) => this.isActive(i) && !this.archivedIds().has(i.projectId);
  /** 区分ごとの件数 */
  todayCounts = computed(() => {
    const now = this.clock.now();
    const c: Record<DueBucket, number> = { overdue: 0, today: 0, tomorrow: 0, in3: 0 };
    for (const i of this.myIssues()) {
      if (!this.counts(i)) continue;
      const b = dueBucket(i.dueAt.toMillis(), now, this.tz());
      if (b) c[b]++;
    }
    return c;
  });
  /** 7日以上たった、未整理のメモの数 */
  oldMemos = computed(() => this.inbox.active().filter((m) => this.inbox.isOld(m)).length);
  hasToday = computed(() => Object.values(this.todayCounts()).some((n) => n > 0) || this.oldMemos() > 0);
  /** 初期は自分の手が必要なもの（未着手・対応中・保留）。切り替えで解決済み・クローズも表示 */
  /**
   * 自分の課題を、期限の見出しで区切る（今日のまとめのチップと同じ区分 ＋「それより先」）。
   * チェックを入れたときだけ、一番下に「終わった課題」。0件の見出しは出さない
   */
  sections = computed(() => {
    const now = this.clock.now();
    const keys = ['overdue', 'today', 'tomorrow', 'in3', 'later', 'done'] as const;
    const map = new Map<string, (Issue & { projectId: string })[]>(keys.map((k) => [k, []]));
    for (const i of this.myIssues()) {
      // アーカイブ中のプロジェクトの課題と、削除フォルダの中は出さない（今までどおり）
      if (this.archivedIds().has(i.projectId) || i.status === 'deleted') continue;
      if (!this.isActive(i)) {
        if (this.showDone()) map.get('done')!.push(i);
        continue;
      }
      map.get(dueBucket(i.dueAt.toMillis(), now, this.tz()) ?? 'later')!.push(i);
    }
    return keys
      .map((key) => ({
        key,
        label: key === 'later' || key === 'done' ? 'mine.' + key : 'today.buckets.' + key,
        items: map.get(key)!.sort((a, b) => compareIssues(a, b, now)),
      }))
      .filter((s) => s.items.length);
  });

  /** たたんでいる期限の見出し（この端末に覚えておく。次に開いても、たたんだまま） */
  private readonly foldKey = `issuemanager.homeFold.${auth.currentUser!.uid}`;
  folded = signal<Set<string>>((() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.foldKey) ?? '[]') as string[]);
    } catch {
      return new Set<string>();
    }
  })());

  toggleFold(k: string) {
    const next = new Set(this.folded());
    if (next.has(k)) next.delete(k);
    else next.add(k);
    this.folded.set(next);
    try {
      localStorage.setItem(this.foldKey, JSON.stringify([...next]));
    } catch {
      // 覚えておけなくても、たたむこと自体はできる
    }
  }

  needsVerify = signal(false);
  info = signal('');
  /** プロジェクトから外されて戻ってきたときの知らせ（プロジェクト名。わからなければ空文字。知らせがなければ null） */
  removedFrom = signal<string | null>(
    ((history.state as Record<string, unknown> | null)?.['removedFrom'] as string | undefined) ?? null);
  /** 自分から抜けて戻ってきたときの知らせ（プロジェクト名） */
  leftFrom = signal<string | null>(
    ((history.state as Record<string, unknown> | null)?.['leftFrom'] as string | undefined) ?? null);
  /** プロジェクトが削除されて戻ってきたときの知らせ（byMe＝自分で消した） */
  deletedProject = signal<{ name: string; byMe: boolean } | null>((() => {
    const s = (history.state ?? {}) as Record<string, unknown>;
    return typeof s['deletedProject'] === 'string' ? { name: s['deletedProject'] as string, byMe: !!s['byMe'] } : null;
  })());
  loading = signal(true);
  busy = signal(false);
  error = signal('');
  /** プロジェクトが1つもないときの「プロジェクトを作成」 */
  newOpen = signal(false);
  private search = inject(SearchService);
  private sample = inject(SampleService);
  private router = inject(Router);
  sampleBusy = signal(false);
  /**
   * ようこその箱：進行中のプロジェクトが0件（全部アーカイブした・外れた人も）で、届いている招待もなく、
   * 「後で見る」を押していないとき（招待が届いている人は、まず参加してもらう）
   */
  showIntro = computed(() => !this.loading() && !this.activeProjects().length && !this.invitations().length
    && !this.authService.profile()?.introHidden);

  /** 見本を作って、かんばんを開く */
  async trySample() {
    this.sampleBusy.set(true);
    this.error.set('');
    try {
      const pid = await this.sample.create();
      await this.router.navigate(['/p', pid, 'board']);
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
      await this.load(); // 途中までできていれば、一覧に出す
    } finally {
      this.sampleBusy.set(false);
    }
  }

  /** 後で見る：箱を閉じる（設定の「イントロダクション」から、いつでも戻せる） */
  async later() {
    try {
      await this.authService.updateProfile({ introHidden: true });
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    }
  }

  ngOnInit() {
    // 外されたときの知らせは1回だけ。読んだら履歴から消し、再読み込みで出し直さない
    const { removedFrom, leftFrom, deletedProject, byMe, ...rest } = (history.state ?? {}) as Record<string, unknown>;
    if (removedFrom !== undefined || leftFrom !== undefined || deletedProject !== undefined) {
      history.replaceState(rest, '');
    }
    const u = auth.currentUser!;
    this.needsVerify.set(!!u.email && !u.emailVerified);
    this.watchInvitations();
    // 「自分の課題」の見張りは、プロジェクト一覧を読んだあとに張る（load の中）
    this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      this.projects.set(await this.projectService.listMyProjects(auth.currentUser!.uid));
      this.syncMine();
      this.syncRequests();
    } catch (e) {
      console.error(e);
      this.error.set('common.loadError');
    } finally {
      this.loading.set(false);
    }
  }

  /** 自分宛ての招待を見張る。メールの確認が済むまでは読めないので始めない */
  private watchInvitations() {
    const email = auth.currentUser!.email;
    if (!email || this.needsVerify() || this.stopInvitations) return;
    this.stopInvitations = this.projectService.watchMyInvitations(
      email,
      (list) => this.invitations.set(list),
      (e) => console.error('招待の見張りに失敗', e),
    );
  }

  /** 所属するプロジェクトに合わせて、「自分の課題」の見張りを張り直す（増えたら始め、なくなったらやめる） */
  private syncMine() {
    const uid = auth.currentUser!.uid;
    const pids = new Set(this.projects().map((p) => p.id));
    // 一覧からなくなったプロジェクトの見張りをやめる
    for (const pid of [...this.mineStops.keys()]) {
      if (!pids.has(pid)) this.stopMineIn(pid);
    }
    // 新しく増えたプロジェクトに見張りを張る
    for (const pid of pids) {
      if (this.mineStops.has(pid) || this.mineFailed.has(pid)) continue;
      this.mineStops.set(pid, this.issueService.watchMyIssuesIn(
        pid, uid,
        (issues) => this.mineByProject.update((m) => ({ ...m, [pid]: issues })),
        (e) => {
          console.error('自分の課題の見張りに失敗', pid, e);
          // 外された・抜けたプロジェクトの分だけ止める。ほかのプロジェクトの見張りは動き続ける
          this.mineFailed.add(pid);
          this.stopMineIn(pid);
          if (e.code === 'permission-denied') this.load();
        },
      ));
    }
  }

  /** 自分が管理者のプロジェクト（アーカイブ中は除く）だけ、依頼を見張る。増えたら始め、外れたらやめる */
  private syncRequests() {
    const pids = new Set(this.projects().filter((p) => p.role === 'admin' && !p.archived).map((p) => p.id));
    for (const [pid, stop] of [...this.reqStops]) {
      if (pids.has(pid)) continue;
      stop();
      this.reqStops.delete(pid);
      this.reqCount.update((m) => {
        const { [pid]: _gone, ...rest } = m;
        return rest;
      });
    }
    for (const pid of pids) {
      if (this.reqStops.has(pid)) continue;
      this.reqStops.set(pid, this.requests.watchOpen(pid,
        (list) => this.reqCount.update((m) => ({ ...m, [pid]: list.length })),
        (e) => console.error('依頼の見張りに失敗', pid, e)));
    }
  }

  /** 1つのプロジェクトの見張りをやめ、その課題を表示から外す */
  private stopMineIn(pid: string) {
    this.mineStops.get(pid)?.();
    this.mineStops.delete(pid);
    this.mineByProject.update((m) => {
      const { [pid]: _removed, ...rest } = m;
      return rest;
    });
  }

  async accept(inv: Invitation) {
    this.busy.set(true);
    try {
      await this.projectService.acceptInvitation(inv, auth.currentUser!);
      this.search.invalidate(); // 参加したプロジェクトも、検索に出るように
      await this.load();
    } catch (e) {
      console.error(e);
      this.error.set('common.saveError');
    } finally {
      this.busy.set(false);
    }
  }

  async decline(inv: Invitation) {
    await this.projectService.declineInvitation(inv);
  }
  async resendVerification() {
    await sendEmailVerification(auth.currentUser!);
    this.info.set('verify.sent');
  }

  /** 確認メールのリンクを押したあと、ログイン情報を取り直して反映する */
  async checkVerified() {
    const u = auth.currentUser!;
    await u.reload();
    await u.getIdToken(true);
    this.needsVerify.set(!u.emailVerified);
    this.watchInvitations();
    await this.load();
  }


  /** 今日のまとめのチップを押したら、下のその見出しへ飛ぶ */
  jump(b: DueBucket) {
    if (this.folded().has(b)) this.toggleFold(b);
    // 開いた一覧が描かれてから動かす
    setTimeout(() => document.getElementById('sec-' + b)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  projectName(pid: string) {
    return this.projects().find((p) => p.id === pid)?.name ?? '';
  }
  isActive(i: Issue) {
    return i.status === 'open' || i.status === 'in_progress' || i.status === 'on_hold';
  }
  isOverdue(i: Issue) {
    return this.isActive(i) && i.dueAt.toMillis() < this.clock.now();
  }
  prio(i: Issue): Level {
    return priorityOf(i, this.clock.now());
  }
  manual(i: Issue) {
    return isManualPriority(i);
  }
  remaining(i: Issue) {
    const r = remainingOf(i.dueAt.toMillis(), this.clock.now());
    return this.i18n.t(r.key, { n: String(r.n) });
  }
  dueLabel(i: Issue) {
    return shortDue(i.dueAt.toDate(), this.tz(), this.i18n.lang(), this.clock.now());
  }
}