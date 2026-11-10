import { Component, OnInit, inject, signal, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StorageUploadService } from '../../core/services/storage/storage-upload.service';
import { SupabaseService } from '../../core/services/supabase/supabase.service';
import { DriverService } from '../../core/services/driver/driver.service';
import { HttpClient } from '@angular/common/http';
import { ApiUrlService } from '../../core/services/api-url.service';
import { AuthService } from '../../core/services/auth/auth.service';
import { firstValueFrom } from 'rxjs';

export const INSPECTION_SLOTS = [
    { key: 'front', label: 'Front' },
    { key: 'rear', label: 'Rear' },
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'seats_interior', label: 'Seats / interior' },
    { key: 'left_side', label: 'Full left side' },
    { key: 'right_side', label: 'Full right side' },
] as const;

export const BIKE_INSPECTION_SLOTS = [
    { key: 'front', label: 'Bike front' },
    { key: 'rear', label: 'Bike rear' },
    { key: 'side', label: 'Bike side' },
] as const;

type SlotStatus = { status: string; rejection_reason?: string | null };

@Component({
    selector: 'app-driver-vehicle-inspection',
    standalone: true,
    imports: [CommonModule],
    template: `
    <section class="space-y-3" data-testid="vehicle-inspection">
      <h3 class="text-sm font-black text-slate-900">Vehicle inspection photos</h3>
      <p class="text-xs text-slate-500">Take each photo clearly in daylight. Approved photos are linked to your current vehicle — a vehicle change requires new photos.</p>
      @for (slot of slots; track slot.key) {
        <div class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3" [attr.data-testid]="'inspection-slot-' + slot.key">
          <div class="min-w-0">
            <p class="text-sm font-bold text-slate-900">{{ slot.label }}</p>
            <p class="text-xs" [class]="statusClass(state()[slot.key]?.status)">{{ statusLabel(state()[slot.key]?.status) }}</p>
            @if (state()[slot.key]?.rejection_reason) {
              <p class="text-xs text-red-600" data-testid="inspection-reason">{{ state()[slot.key]!.rejection_reason }}</p>
            }
          </div>
          <label class="shrink-0 cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700"
                 [class.opacity-50]="uploading() === slot.key">
            {{ uploading() === slot.key ? 'Uploading…' : (hasPhoto(slot.key) ? 'Replace' : 'Upload') }}
            <input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" [disabled]="uploading() === slot.key" (change)="onFile(slot.key, $event)" />
          </label>
        </div>
      }
      @if (error()) { <p class="text-xs text-red-600" role="alert">{{ error() }}</p> }
    </section>`,
})
export class DriverVehicleInspectionComponent implements OnInit {
    @Input() slots: ReadonlyArray<{ key: string; label: string }> = INSPECTION_SLOTS;
    state = signal<Record<string, SlotStatus>>({});
    uploading = signal<string | null>(null);
    error = signal('');

    private storage = inject(StorageUploadService);
    private supabase = inject(SupabaseService);
    private http = inject(HttpClient);
    private apiUrl = inject(ApiUrlService);
    private auth = inject(AuthService);
    private driverService = inject(DriverService);

    async ngOnInit() { await this.refresh(); }

    hasPhoto(slot: string) { return ['uploaded', 'under_review', 'approved'].includes(this.state()[slot]?.status || ''); }

    statusLabel(s?: string) {
        switch (s) {
            case 'approved': return 'Approved';
            case 'under_review': return 'Under review';
            case 'rejected': return 'Rejected — upload a new photo';
            case 'replacement_required': return 'Replacement required';
            case 'uploaded': return 'Uploaded';
            default: return 'Not uploaded';
        }
    }

    statusClass(s?: string) {
        if (s === 'approved') return 'text-emerald-600';
        if (s === 'rejected' || s === 'replacement_required') return 'text-red-600';
        if (s === 'under_review') return 'text-amber-600';
        return 'text-slate-500';
    }

    async refresh() {
        try {
            const headers = { Authorization: `Bearer ${await (this.driverService as any).getAccessToken?.() || ''}` };
            const res = await firstValueFrom(this.http.get<{ slots: Record<string, SlotStatus> }>(
                this.apiUrl.getApiUrl('/api/driver-onboarding/inspection-photos'), { headers }));
            this.state.set(res.slots || {});
        } catch { /* keep prior state on refresh failure */ }
    }

    async onFile(slot: string, ev: Event) {
        const file = (ev.target as HTMLInputElement).files?.[0];
        if (!file) return;
        this.uploading.set(slot); this.error.set('');
        try {
            const user = this.auth.currentUser();
            if (!user) throw new Error('Sign in required');
            // Private path: inspection/{driver}/{slot}-{uuid}.{ext}
            const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
            const path = `inspection/${user.id}/${slot}-${crypto.randomUUID()}.${ext}`;
            await this.storage.uploadFile('driver-docs', path, file);
            const headers = { Authorization: `Bearer ${await (this.driverService as any).getAccessToken?.() || ''}` };
            await firstValueFrom(this.http.post(this.apiUrl.getApiUrl('/api/driver-onboarding/inspection-photo'), { slot, path }, { headers }));
            await this.refresh();
        } catch (e: any) {
            this.error.set(e?.error?.error || e?.message || 'Upload failed — try again.');
        } finally {
            this.uploading.set(null);
        }
    }
}
