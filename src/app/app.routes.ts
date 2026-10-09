import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './core/auth/auth.service';
import { authGuard, guestGuard, unsavedGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login) },
  { path: '', canActivate: [authGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.Projects) },
  { path: 'new', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue/issue-new').then((m) => m.IssueNew) },
  { path: 'p/:pid/new', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue/issue-new').then((m) => m.IssueNew) },
  { path: 'p/:pid/i/:iid', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue/issue-detail').then((m) => m.IssueDetail) },
    { path: 'p/:pid', canActivate: [authGuard],
      loadComponent: () => import('./pages/project/project-shell').then((m) => m.ProjectHome),
      children: [
        // 初期表示のタブ（設定で選べるようにする。未設定ならリスト）
        { path: '', pathMatch: 'full', redirectTo: () => inject(AuthService).profile()?.defaultView ?? 'list' },
        { path: 'list',
          loadComponent: () => import('./pages/project/tab-list').then((m) => m.TabList) },
        { path: 'board',
            loadComponent: () => import('./pages/project/tab-board').then((m) => m.ProjectBoard) },
        { path: 'calendar',
          loadComponent: () => import('./pages/project/tab-calendar').then((m) => m.ProjectCalendar) },
        { path: 'members',
          loadComponent: () => import('./pages/project/tab-members').then((m) => m.ProjectMembers) },
        { path: 'settings', canDeactivate: [unsavedGuard],
          loadComponent: () => import('./pages/project/tab-settings').then((m) => m.ProjectSettings) },
      ] },
  { path: 'settings', canActivate: [authGuard], canDeactivate: [unsavedGuard],
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings) },
  { path: '**', redirectTo: '' },
];