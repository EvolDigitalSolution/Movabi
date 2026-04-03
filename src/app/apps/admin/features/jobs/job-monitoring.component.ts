import { Component, inject, OnInit, OnDestroy, ViewChild, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { MapService } from '@core/services/logistics/map.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { Job, DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Component({
  selector: 'app-job-monitoring',
  template: `
    <div class="space-y-8">
      <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div class="p-8 border-b border-gray-100">
          <h3 class="text-xl font-bold text-gray-900">Live Fleet View</h3>
          <p class="text-sm text-gray-500 mt-1">Real-time driver positions across the tenant.</p>
        </div>
        <div #mapContainer class="h-96 bg-gray-100"></div>
      </div>

      <div class="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
        <div class="p-8 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 class="text-xl font-bold text-gray-900">Van Moving Monitoring</h3>
            <p class="text-sm text-gray-500 mt-1">Real-time overview of all moving jobs.</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="bg-gray-50/50 border-b border-gray-100">
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Job ID</th>
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Customer</th>
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Driver</th>
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Route</th>
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Status</th>
                <th class="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Price</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              @for (job of jobs(); track job.id) {
                <tr class="hover:bg-gray-50/50 transition-all">
                  <td class="px-8 py-4 text-sm font-mono text-gray-400">#{{ job.id.slice(0,8) }}</td>
                  <td class="px-8 py-4">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs">
                        {{ job.customer?.first_name?.[0] }}
                      </div>
                      <div>
                        <p class="text-sm font-bold text-gray-900">{{ job.customer?.first_name }} {{ job.customer?.last_name }}</p>
                        <p class="text-xs text-gray-400">{{ job.customer?.email }}</p>
                      </div>
                    </div>
                  </td>
                  <td class="px-8 py-4">
                    @if (job.driver) {
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-bold text-xs">
                          {{ job.driver.first_name[0] }}
                        </div>
                        <div>
                          <p class="text-sm font-bold text-gray-900">{{ job.driver.first_name }} {{ job.driver.last_name }}</p>
                          <p class="text-xs text-gray-400">{{ job.driver.phone }}</p>
                        </div>
                      </div>
                    } @else {
                      <span class="text-xs text-amber-500 font-bold uppercase tracking-widest">Unassigned</span>
                    }
                  </td>
                  <td class="px-8 py-4">
                    <div class="text-xs space-y-1">
                      <p><span class="text-gray-400">From:</span> {{ job.pickup_address }}</p>
                      <p><span class="text-gray-400">To:</span> {{ job.dropoff_address }}</p>
                    </div>
                  </td>
                  <td class="px-8 py-4">
                    <span [class]="'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-widest ' + getStatusClass(job.status)">
                      {{ job.status }}
                    </span>
                  </td>
                  <td class="px-8 py-4 text-sm font-bold text-gray-900">£{{ job.price }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class JobMonitoringComponent implements OnInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef;

  private jobService = inject(JobService);
  private locationService = inject(LocationService);
  private mapService = inject(MapService);
  private profileService = inject(ProfileService);

  jobs = signal<Job[]>([]);
  private map: any;
  private markers: Map<string, any> = new Map();
  private jobChannel?: RealtimeChannel;
  private locationChannel?: RealtimeChannel;

  async ngOnInit() {
    await this.loadJobs();
    this.jobChannel = this.jobService.subscribeToJobs(() => this.loadJobs());
    await this.mapService.loadGoogleMaps();
    this.initMap();
    this.subscribeToAllLocations();
  }

  ngOnDestroy() {
    this.jobChannel?.unsubscribe();
    this.locationChannel?.unsubscribe();
  }

  initMap() {
    if (!this.mapContainer) return;
    this.map = this.mapService.createMap(this.mapContainer.nativeElement, {
      center: { lat: 51.5074, lng: -0.1278 }, // London
      zoom: 11,
      disableDefaultUI: true
    });
  }

  subscribeToAllLocations() {
    const profile = this.profileService.profile();
    if (!profile) return;

    this.locationChannel = this.locationService.subscribeToAllTenantLocations(profile.tenant_id, (location) => {
      this.updateMarker(location);
    });
  }

  updateMarker(location: DriverLocation) {
    if (!this.map) return;
    const pos = { lat: location.lat, lng: location.lng };
    let marker = this.markers.get(location.driver_id);
    
    if (marker) {
      marker.setPosition(pos);
    } else {
      marker = this.mapService.addMarker(this.map, pos, 'https://maps.google.com/mapfiles/ms/icons/bus.png');
      this.markers.set(location.driver_id, marker);
    }
  }

  async loadJobs() {
    this.jobs.set(await this.jobService.getAllJobs());
  }

  getStatusClass(status: string) {
    switch (status) {
      case 'pending': return 'bg-amber-100 text-amber-600';
      case 'accepted': return 'bg-blue-100 text-blue-600';
      case 'in_progress': return 'bg-indigo-100 text-indigo-600';
      case 'completed': return 'bg-emerald-100 text-emerald-600';
      case 'cancelled': return 'bg-red-100 text-red-600';
      default: return 'bg-gray-100 text-gray-600';
    }
  }
}
