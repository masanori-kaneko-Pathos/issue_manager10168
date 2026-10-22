import { ProjectWithRole } from '../models';

/** 引き出しに、最初から見せるプロジェクトの数（残りはたたむ） */
export const PROJECT_FOLD = 8;

/**
 * 進行中のプロジェクトの並び（アーカイブ済みは除く）。プロジェクトのページと引き出しで同じ並びにするため、ここ1か所で決める。
 * ・ピン止めの群が上、それ以外が下
 * ・どちらの群も、自分で並べた順（order）。まだ並べていないもの（新しく参加したものなど）は、群の一番上に、参加が新しい順
 */
export function orderProjects(
  list: ProjectWithRole[], pinned: string[] | undefined, order?: string[],
): ProjectWithRole[] {
  const pins = new Set(pinned ?? []);
  const pos = new Map((order ?? []).map((id, i) => [id, i]));
  const joined = (p: ProjectWithRole) => p.joinedAt?.toMillis() ?? 0;
  return list.filter((p) => !p.archived).sort((a, b) => {
    const pin = Number(pins.has(b.id)) - Number(pins.has(a.id));
    if (pin) return pin;
    const ia = pos.get(a.id);
    const ib = pos.get(b.id);
    if (ia === undefined && ib === undefined) return joined(b) - joined(a) || a.name.localeCompare(b.name);
    if (ia === undefined) return -1; // 並べていないものが上
    if (ib === undefined) return 1;
    return ia - ib;
  });
}