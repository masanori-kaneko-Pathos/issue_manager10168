import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { computed, inject } from '@angular/core';
import { AuthService } from './core/auth.service';
import { AppHeader } from './shared/app-header';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, AppHeader],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('issuemanager_10168');
  private authService = inject(AuthService);
  protected signedIn = computed(() => !!this.authService.user());
}
