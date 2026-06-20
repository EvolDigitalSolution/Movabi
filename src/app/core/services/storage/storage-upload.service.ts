import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable({
  providedIn: 'root'
})
export class StorageUploadService {
  private supabase = inject(SupabaseService);

  async uploadFile(bucket: string, path: string, file: File): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(bucket)
      .upload(path, file, {
        upsert: true,
        contentType: file.type || undefined,
        cacheControl: '3600'
      });

    if (error) throw error;
    return data.path;
  }

  async getPublicUrl(bucket: string, path: string): Promise<string> {
    const { data } = this.supabase.storage
      .from(bucket)
      .getPublicUrl(path);
    
    return data.publicUrl;
  }

  async deleteFile(bucket: string, path: string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(bucket)
      .remove([path]);

    if (error) throw error;
  }

  async uploadProfileImage(userId: string, file: File): Promise<string> {
    const extension = this.getSafeExtension(file, 'jpg');
    const path = `avatars/${userId}/${Date.now()}.${extension}`;
    return this.uploadFile('profiles', path, file);
  }

  async uploadDriverDocument(userId: string, type: string, file: File): Promise<string> {
    const extension = this.getSafeExtension(file, 'pdf');
    const path = `documents/${userId}/${type}_${Date.now()}.${extension}`;
    return this.uploadFile('driver-docs', path, file);
  }

  private getSafeExtension(file: File, fallback: string): string {
    const extension = String(file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (extension) return extension;

    if (file.type === 'image/png') return 'png';
    if (file.type === 'image/webp') return 'webp';
    if (file.type === 'image/jpeg') return 'jpg';
    if (file.type === 'application/pdf') return 'pdf';

    return fallback;
  }
}
