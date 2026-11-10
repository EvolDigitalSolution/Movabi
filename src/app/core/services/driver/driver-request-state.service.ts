import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';

/** Driver-scoped UI exclusions; server decline records remain authoritative. */
@Injectable({ providedIn: 'root' })
export class DriverRequestStateService {
    private auth = inject(AuthService);
    private stored = new Map<string, Set<string>>();
    private revision = signal(0);
    private attention = signal<Record<string, string[]>>({});
    private ids(owner: string): Set<string> {
        if (!this.stored.has(owner)) {
            let values: unknown = [];
            try { values = JSON.parse(localStorage.getItem('movabi.driver.passed.' + owner) || '[]'); } catch {}
            this.stored.set(owner, new Set(Array.isArray(values) ? values.filter((id): id is string => typeof id === 'string') : []));
        }
        return this.stored.get(owner)!;
    }
    has(jobId: string): boolean {
        this.revision();
        const owner = this.auth.currentUser()?.id;
        return !!owner && this.ids(owner).has(jobId);
    }
    acknowledge(jobId: string): void {
        const owner = this.auth.currentUser()?.id;
        if (!owner || !jobId) return;
        this.attention.update(all => ({ ...all, [owner]: [...new Set([...(all[owner] || []), jobId])] }));
    }
    isMuted(jobId: string): boolean {
        const owner = this.auth.currentUser()?.id;
        return this.has(jobId) || !!(owner && this.attention()[owner]?.includes(jobId));
    }
    suppress(jobId: string, owner = this.auth.currentUser()?.id): void {
        this.merge([jobId], owner);
    }
    merge(jobIds: string[], owner = this.auth.currentUser()?.id): void {
        if (!owner || owner !== this.auth.currentUser()?.id) return;
        const ids = this.ids(owner);
        let changed = false;
        for (const id of jobIds) if (id && !ids.has(id)) { ids.add(id); changed = true; }
        if (!changed) return;
        try { localStorage.setItem('movabi.driver.passed.' + owner, JSON.stringify([...ids])); } catch {}
        this.revision.update(value => value + 1);
    }
}
