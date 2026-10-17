import { Issue, IssueStatus, Role } from '../models';

export type TransitionKey =
'start' | 'hold' | 'resume' | 'resolve' | 'sendBack' | 'close' | 'reject' | 'reopen' | 'unreject' | 'unstart';

export interface Transition {
  key: TransitionKey;
  from: IssueStatus[];
  to: IssueStatus;
  who: 'worker' | 'owner' | 'admin'; // worker=担当者か管理者, owner=提起者か管理者
  needs: 'none' | 'reason' | 'resolve' | 'close';
}

export const TRANSITIONS: Transition[] = [
  { key: 'start',    from: ['open'],                  to: 'in_progress', who: 'worker', needs: 'none' },
  { key: 'hold',     from: ['open', 'in_progress'],   to: 'on_hold',     who: 'worker', needs: 'reason' },
  { key: 'resume',   from: ['on_hold'],               to: 'in_progress', who: 'worker', needs: 'none' },
  { key: 'resolve',  from: ['in_progress'],           to: 'resolved',    who: 'worker', needs: 'resolve' },
  { key: 'sendBack', from: ['resolved'],              to: 'in_progress', who: 'owner',  needs: 'reason' },
  { key: 'close',    from: ['resolved'],              to: 'closed',      who: 'owner',  needs: 'close' },
  { key: 'unstart',  from: ['in_progress'],           to: 'open',        who: 'worker', needs: 'none' },
  { key: 'reject',   from: ['open', 'in_progress', 'on_hold'], to: 'rejected', who: 'admin', needs: 'reason' },
  { key: 'unreject', from: ['rejected'],              to: 'open',        who: 'admin',  needs: 'reason' },
  { key: 'reopen',   from: ['closed'],                to: 'in_progress', who: 'admin',  needs: 'reason' },
];

function canDo(t: Transition, issue: Issue, role: Role, uid: string): boolean {
  if (role === 'admin') return true;
  if (role !== 'member') return false;
  if (t.who === 'worker') return issue.assigneeId === uid;
  if (t.who === 'owner') return issue.reporterId === uid;
  return false;
}

/** 今のステータスから選べる変更と、その人ができるかどうか */
export function availableTransitions(issue: Issue, role: Role, uid: string) {
  return TRANSITIONS
    .filter((t) => t.from.includes(issue.status))
    .map((t) => ({ t, allowed: canDo(t, issue, role, uid) }));
}

/** 入力の要らない移動の、逆の移動（元に戻すに使う）。ここにないものは戻せない */
export const UNDO_OF: Partial<Record<TransitionKey, TransitionKey>> = {
  start: 'unstart',
  unstart: 'start',
  resume: 'hold', // 保留の理由は、元の理由をそのまま使う
};