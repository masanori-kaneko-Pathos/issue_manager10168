import { ProjectWithRole } from '../models';

/** ホームの左の列と、引き出しに、最初から見せるプロジェクトの数（残りはたたむ） */
export const PROJECT_FOLD = 8;

/**
 * 進行中のプロジェクトの並び：ピン止めが上、その中も残りも名前順（アーカイブ済みは除く）。
 * ホームと引き出しで同じ並びにするため、ここ1か所で決める
 */
export function orderProjects(list: ProjectWithRole[], pinned: string[] | undefined): ProjectWithRole[] {
  const pins = new Set(pinned ?? []);
  return list.filter((p) => !p.archived)
    .sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || a.name.localeCompare(b.name));
}