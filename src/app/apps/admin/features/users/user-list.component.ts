import { Component, inject, OnInit, signal } from '@angular/core';
import { AdminService } from '../../services/admin.service';
import { Profile } from '../../../../shared/models/booking.model';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-user-list',
  template: `
    <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
      <div class="p-8 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 class="text-xl font-bold text-gray-900">User Management</h3>
          <p class="text-sm text-gray-500 mt-1">Manage and monitor all customer accounts.</p>
        </div>
        <div class="flex items-center gap-4">
          <div class="relative">
            <ion-icon name="search-outline" class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></ion-icon>
            <input type="text" placeholder="Search users..." 
                   class="bg-gray-50 border border-gray-200 rounded-xl pl-11 pr-4 py-2 text-sm font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 w-64">
          </div>
          <button class="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20">
            Export CSV
          </button>
        </div>
      </div>
      

      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="bg-gray-50/50 border-b border-gray-100">
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">User</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Email</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Joined</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Status</th>
              <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            @for (user of users(); track user.id) {
              <tr class="hover:bg-gray-50/50 transition-all group">
                <td class="px-8 py-4">
                  <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                      {{ user.first_name[0] || user.email[0] }}
                    </div>
                    <div>
                      <h4 class="text-sm font-bold text-gray-900">{{ user.first_name }} {{ user.last_name }}</h4>
                      <p class="text-xs text-gray-400">ID: {{ user.id.slice(0, 8) }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-8 py-4 text-sm font-medium text-gray-600">{{ user.email }}</td>
                <td class="px-8 py-4 text-sm font-medium text-gray-600">{{ user.created_at | date:'mediumDate' }}</td>
                <td class="px-8 py-4">
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-600 uppercase tracking-widest">
                    Active
                  </span>
                </td>
                <td class="px-8 py-4 text-right">
                  <button class="p-2 text-gray-400 hover:text-blue-600 transition-all">
                    <ion-icon name="create-outline" class="text-xl"></ion-icon>
                  </button>
                  <button class="p-2 text-gray-400 hover:text-red-600 transition-all">
                    <ion-icon name="trash-outline" class="text-xl"></ion-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  imports: [CommonModule, IonicModule]
})
export class UserListComponent implements OnInit {
  private adminService = inject(AdminService);
  users = signal<Profile[]>([]);

  async ngOnInit() {
    const data = await this.adminService.getUsers();
    this.users.set(data);
  }
}
