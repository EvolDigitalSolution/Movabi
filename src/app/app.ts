import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {IonApp, IonRouterOutlet, IonIcon} from '@ionic/angular/standalone';
import {SupabaseService} from './core/services/supabase/supabase.service';
import {CommonModule} from '@angular/common';
import {addIcons} from 'ionicons';
import {warningOutline} from 'ionicons/icons';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet, IonIcon, CommonModule],
  template: `
    <ion-app>
      @if (!isConfigured) {
        <div class="fixed top-0 left-0 right-0 z-[1000] bg-amber-500 text-white p-4 text-center shadow-lg animate-bounce-slow">
          <div class="max-w-4xl mx-auto flex items-center justify-center gap-3">
            <ion-icon name="warning-outline" class="text-2xl"></ion-icon>
            <div>
              <p class="font-bold">Supabase Configuration Missing</p>
              <p class="text-xs opacity-90">Please set <code class="bg-amber-600 px-1 rounded">SUPABASE_URL</code> and <code class="bg-amber-600 px-1 rounded">SUPABASE_ANON_KEY</code> in the Settings menu.</p>
            </div>
          </div>
        </div>
      }
      <ion-router-outlet></ion-router-outlet>
    </ion-app>
  `,
  styleUrl: './app.css',
})
export class App {
  private supabase = inject(SupabaseService);
  isConfigured = this.supabase.isConfigured;

  constructor() {
    addIcons({warningOutline});
  }
}
