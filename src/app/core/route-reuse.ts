import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/**
 * 画面を使い回すかの決まり。Angular の標準は「同じ道なら使い回す」だが、
 * それだと /p/A/i/1 → /p/A/i/2 で画面が作り直されず、前の課題を見張り続ける。
 * そこで「同じ道で、:pid・:iid などの値も同じときだけ使い回す」にする
 */
export class ParamsRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig
      && JSON.stringify(future.params) === JSON.stringify(curr.params);
  }
}