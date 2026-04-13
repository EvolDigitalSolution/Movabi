import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { BadgeComponent } from '../../../../shared/ui/badge';
import { ButtonComponent } from '../../../../shared/ui/button';
import { AuthService } from '../../../../core/services/auth/auth.service';

@Component({
  selector: 'app-user-list',
  template: `
    <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
      <div class="p-10 border-b border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h3 class="text-2xl font-display font-bold text-slate-900">User Management</h3>
          <p class="text-slate-500 font-medium mt-1">Manage and monitor all customer accounts.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-4">
          <div class="relative w-full sm:w-72 group">
            <ion-icon name="search-outline" class="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-600 transition-colors"></ion-icon>
            <input type="text" placeholder="Search users..." 
                   class="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-5 py-3 text-sm font-medium text-slate-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500/50 transition-all">
          </div>
          <app-button variant="secondary" size="md" [fullWidth]="false" class="px-8 h-12 rounded-2xl">
            <ion-icon name="download-outline" slot="start" class="mr-2"></ion-icon>
            Export CSV
          </app-button>
        </div>
      </div>
      

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50/50">
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">User</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Email</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Joined</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
              <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            @for (user of users(); track user.id) {
              <tr class="hover:bg-slate-50/80 transition-all group">
                <td class="px-10 py-6">
                  <div class="flex items-center gap-4">
                    <div class="w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-sm border border-blue-100 shadow-sm">
                      {{ user.first_name[0] || user.email[0] }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-slate-900">{{ user.first_name }} {{ user.last_name }}</h4>
                      <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">ID: {{ user.id.slice(0, 8) }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-10 py-6 text-sm font-bold text-slate-900">{{ user.email }}</td>
                <td class="px-10 py-6 text-sm font-bold text-slate-900">{{ user.created_at | date:'mediumDate' }}</td>
                <td class="px-10 py-6">
                  <app-badge [variant]="getStatusVariant(user.account_status || 'active')">
                    {{ (user.account_status || 'active') | uppercase }}
                  </app-badge>
                </td>
                <td class="px-10 py-6 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <button (click)="moderateUser(user)" 
                            class="w-10 h-10 rounded-xl bg-slate-50 text-slate-400 hover:bg-blue-600 hover:text-white hover:shadow-lg hover:shadow-blue-600/20 transition-all flex items-center justify-center"
                            title="Moderate User">
                      <ion-icon name="shield-outline" class="text-xl"></ion-icon>
                    </button>
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent, ButtonComponent]
})
export class UserListComponent implements OnInit {
  private adminService = inject(AdminService);
  private authService = inject(AuthService);
  private alertCtrl = inject(AlertController);
  private toastCtrl = inject(ToastController);

  users = signal<Profile[]>([]);

  async ngOnInit() {
    await this.loadUsers();
  }

  async loadUsers() {
    const data = await this.adminService.getUsers();
    this.users.set(data);
  }

  getStatusVariant(status: string) {
    switch (status) {
      case 'active': return 'success';
      case 'suspended': return 'warning';
      case 'banned': return 'error';
      case 'disabled': return 'secondary';
      default: return 'success';
    }
  }

  async moderateUser(user: Profile) {
    const alert = await this.alertCtrl.create({
      header: 'Moderate User',
      subHeader: `${user.first_name} ${user.last_name}`,
      inputs: [
        {
          name: 'status',
          type: 'radio',
          label: 'Active',
          value: 'active',
          checked: user.account_status === 'active' || !user.account_status
        },
        {
          name: 'status',
          type: 'radio',
          label: 'Suspend',
          value: 'suspended',
          checked: user.account_status === 'suspended'
        },
        {
          name: 'status',
          type: 'radio',
          label: 'Ban',
          value: 'banned',
          checked: user.account_status === 'banned'
        },
        {
          name: 'status',
          type: 'radio',
          label: 'Disable',
          value: 'disabled',
          checked: user.account_status === 'disabled'
        },
        {
          name: 'reason',
          type: 'textarea',
          placeholder: 'Reason for moderation...'
        }
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Apply',
          handler: async (data) => {
            if (!data.status) return;
            try {
              await this.adminService.updateAccountStatus(
                user.id, 
                data.status, 
                data.reason || '', 
                this.authService.currentUser()?.id || ''
              );
              const toast = await this.toastCtrl.create({
                message: `User status updated to ${data.status}`,
                duration: 2000,
                color: 'success'
              });
              await toast.present();
              await this.loadUsers();
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
              const toast = await this.toastCtrl.create({
                message: errorMessage,
                duration: 3000,
                color: 'danger'
              });
              await toast.present();
            }
          }
        }
      ]
    });

    await alert.present();
  }
}
