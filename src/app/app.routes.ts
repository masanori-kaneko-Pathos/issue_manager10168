import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth.guards';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login) },
  { path: '', canActivate: [authGuard],
    loadComponent: () => import('./pages/projects/projects').then((m) => m.Projects) },
    { path: 'p/:pid', canActivate: [authGuard],
    loadComponent: () => import('./pages/project-home/project-home').then((m) => m.ProjectHome) }, 
    { path: 'p/:pid/new', canActivate: [authGuard],
      loadComponent: () => import('./pages/issue-new/issue-new').then((m) => m.IssueNew) },
  { path: '**', redirectTo: '' },
];