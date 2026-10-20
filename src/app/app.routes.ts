import { Router, Routes } from '@angular/router';
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
        { path: 'gantt',
          loadComponent: () => import('./pages/project/tab-gantt').then((m) => m.TabGantt) },
        { path: 'dashboard',
          loadComponent: () => import('./pages/project/tab-dashboard').then((m) => m.TabDashboard) },
        { path: 'members',
          loadComponent: () => import('./pages/project/tab-members').then((m) => m.ProjectMembers) },
          { path: 'settings', canDeactivate: [unsavedGuard],
            loadComponent: () => import('./pages/project/tab-settings').then((m) => m.ProjectSettings) },
        // 削除フォルダ（タブには出さず、「⋮」メニューから開く）
        { path: 'trash',
          loadComponent: () => import('./pages/project/trash').then((m) => m.Trash) },
        { path: 'requests',
          loadComponent: () => import('./pages/project/requests').then((m) => m.Requests) },
        { path: 'import',
          loadComponent: () => import('./pages/project/import').then((m) => m.ImportPage) },
        ] },
        { path: 'inbox', canActivate: [authGuard],
          loadComponent: () => import('./pages/inbox/inbox').then((m) => m.Inbox) },
        { path: 'inbox/new', canActivate: [authGuard],
          loadComponent: () => import('./pages/inbox/inbox-new').then((m) => m.InboxNew) },
        // メモのページはやめた。古いリンク（/inbox/メモのid）は、受信箱でそのメモを開いた状態に回す
        // （':id' は 'new' より後に置く。先に置くと、'new' がメモの id として扱われてしまう）
        { path: 'inbox/:id',
          redirectTo: ({ params }) => inject(Router).createUrlTree(['/inbox'], { queryParams: { m: params['id'] } }) },
        { path: 'notifications', canActivate: [authGuard],
          loadComponent: () => import('./pages/notification/notifications').then((m) => m.Notifications) },
          { path: 'drafts', canActivate: [authGuard],
            loadComponent: () => import('./pages/draft/drafts').then((m) => m.Drafts) },        
          { path: 'settings/notifications', canActivate: [authGuard],
            loadComponent: () => import('./pages/settings/notify-settings').then((m) => m.NotifySettings) },
          { path: 'settings', canActivate: [authGuard], canDeactivate: [unsavedGuard],
            loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings) },
          { path: '**', redirectTo: '' },
];