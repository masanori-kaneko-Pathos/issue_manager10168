import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { computed, inject } from '@angular/core';
import { AuthService } from './core/auth/auth.service';
import { AppHeader } from './shared/app-header';
import { UndoToast } from './shared/undo-toast';
import { IssueFormHost } from './shared/issue-form-host';
import { ReminderHost } from './shared/reminder-host';
import { DraftsHost } from './shared/drafts-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeader, UndoToast, IssueFormHost, ReminderHost, DraftsHost],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('issuemanager_10168');
  private authService = inject(AuthService);
  protected signedIn = computed(() => !!this.authService.user());
}
