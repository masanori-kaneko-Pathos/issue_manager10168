import { inject } from '@angular/core';
import { CanActivateFn, CanDeactivateFn, Router } from '@angular/router';
import { I18nService } from '../../i18n/i18n';
import { auth } from '../firebase';

export const authGuard: CanActivateFn = async () => {
  const router = inject(Router);
  await auth.authStateReady();
  return auth.currentUser ? true : router.createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  await auth.authStateReady();
  return auth.currentUser ? router.createUrlTree(['/']) : true;
};

/** 未保存の変更がある画面から離れるときに確認する */
export const unsavedGuard: CanDeactivateFn<{ dirty(): boolean }> = (component) => {
  if (!component.dirty()) return true;
  return confirm(inject(I18nService).t('settings.leaveConfirm'));
};