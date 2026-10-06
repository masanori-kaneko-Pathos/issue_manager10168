import { Issue, IssueStatus, Role } from './models';

export type TransitionKey =
  'start' | 'hold' | 'resume' | 'resolve' | 'sendBack' | 'close' | 'reject' | 'reopen';

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
  { key: 'reject',   from: ['open', 'in_progress', 'on_hold', 'resolved'], to: 'rejected', who: 'admin', needs: 'reason' },
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