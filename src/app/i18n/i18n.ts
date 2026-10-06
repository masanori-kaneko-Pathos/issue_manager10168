import { Injectable, Pipe, PipeTransform, inject, signal } from '@angular/core';
import { ja } from './ja';
import { en } from './en';

export type Lang = 'ja' | 'en';
const dicts = { ja, en };

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly lang = signal<Lang>('ja');

  private lookup(key: string): unknown {
    let v: unknown = dicts[this.lang()];
    for (const k of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
    return v;
  }
  has(key: string) {
    return typeof this.lookup(key) === 'string';
  }
  t(key: string, params?: Record<string, string>): string {
    const v = this.lookup(key);
    if (typeof v !== 'string') return key;
    return params ? v.replace(/\{\{(\w+)\}\}/g, (_, p) => params[p] ?? '') : v;
  }
}

@Pipe({ name: 't', pure: false })
export class TPipe implements PipeTransform {
  private i18n = inject(I18nService);
  transform(key: string, params?: Record<string, string>) {
    return this.i18n.t(key, params);
  }
}