import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './core/auth.service';
import { authGuard, guestGuard, unsavedGuard } from './core/auth.guards';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login) },
  { path: '', canActivate: [authGuard],
    loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects) },
  { path: 'new', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue-new/issue-new').then((m) => m.IssueNew) },
  { path: 'p/:pid/new', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue-new/issue-new').then((m) => m.IssueNew) },
  { path: 'p/:pid/i/:iid', canActivate: [authGuard],
    loadComponent: () => import('./pages/issue-detail/issue-detail').then((m) => m.IssueDetail) },
    { path: 'p/:pid', canActivate: [authGuard],
      loadComponent: () => import('./pages/project-home/project-home').then((m) => m.ProjectHome),
      children: [
        // 初期表示のタブ（設定で選べるようにする。未設定ならリスト）
        { path: '', pathMatch: 'full', redirectTo: () => inject(AuthService).profile()?.defaultView ?? 'list' },
        { path: 'list',
          loadComponent: () => import('./pages/project-home/project-list').then((m) => m.ProjectList) },
        { path: 'board',
            loadComponent: () => import('./pages/project-home/project-board').then((m) => m.ProjectBoard) },
        { path: 'members',
          loadComponent: () => import('./pages/project-home/project-members').then((m) => m.ProjectMembers) },
      ] },
  { path: 'settings', canActivate: [authGuard], canDeactivate: [unsavedGuard],
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings) },
  { path: '**', redirectTo: '' },
];