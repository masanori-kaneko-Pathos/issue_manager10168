import { Component, inject } from '@angular/core';
import { ProjectContext } from '../../core/project-context';
import { IssueList } from './issue-list/issue-list';

@Component({
  selector: 'app-project-list',
  imports: [IssueList],
  template: `
    <app-issue-list [pid]="ctx.pid()" [members]="ctx.members()" [canCreate]="ctx.canCreate()"
      [isViewer]="ctx.role() === 'viewer'" />
  `,
})
export class ProjectList {
  protected ctx = inject(ProjectContext);
}