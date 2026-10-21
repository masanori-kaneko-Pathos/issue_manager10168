/**
 * 設定の索引。設定の入れ物の左と、ヘッダーのアカウントのメニューで共通（並びもここで決める）。
 * path は /settings/ の後ろ
 */
export const SETTINGS_NAV = [
    { path: 'profile', key: 'settings.profile', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6' },
    { path: 'preferences', key: 'settingsNav.preferences',
      icon: 'M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4' },
    { path: 'notifications', key: 'notifySettings.title',
      icon: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0' },
    { path: 'account', key: 'settingsNav.account', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
    { path: 'intro', key: 'intro.settingsTitle',
      icon: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6' },
  ];