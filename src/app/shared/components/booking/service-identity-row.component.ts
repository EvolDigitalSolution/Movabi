import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
    selector: 'app-service-identity-row',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div class="flex items-center gap-4 py-1">
      <div
        class="w-[56px] h-[56px] rounded-[16px] flex items-center justify-center shrink-0 border"
        [class.bg-orange-50]="accentColor === 'orange'"
        [class.border-orange-100]="accentColor === 'orange'"
        [class.text-orange-600]="accentColor === 'orange'"
        [class.bg-blue-50]="accentColor === 'blue'"
        [class.border-blue-100]="accentColor === 'blue'"
        [class.text-blue-600]="accentColor === 'blue'"
        [class.bg-slate-50]="accentColor === 'slate'"
        [class.border-slate-100]="accentColor === 'slate'"
        [class.text-slate-600]="accentColor === 'slate'"
        [class.bg-emerald-50]="accentColor === 'green'"
        [class.border-emerald-100]="accentColor === 'green'"
        [class.text-emerald-600]="accentColor === 'green'">
        <ion-icon [name]="icon" class="text-[28px]"></ion-icon>
      </div>
      <div class="flex-1 min-w-0">
        <h2 class="text-xl font-display font-black text-slate-900 leading-snug">{{ title }}</h2>
        <p class="text-sm font-medium text-slate-500 line-clamp-2 mt-0.5">{{ description }}</p>
      </div>
    </div>
  `
})
export class ServiceIdentityRowComponent {
    @Input() title = '';
    @Input() description = '';
    @Input() icon = 'cube-outline';
    @Input() accentColor: 'orange' | 'blue' | 'slate' | 'green' = 'orange';
}
