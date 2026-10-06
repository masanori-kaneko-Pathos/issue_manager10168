import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './core/auth.guards';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login) },
  { path: '', canActivate: [authGuard],
    loadComponent: () => import('./pages/home/home').then((m) => m.Home) },
  { path: '**', redirectTo: '' },
];