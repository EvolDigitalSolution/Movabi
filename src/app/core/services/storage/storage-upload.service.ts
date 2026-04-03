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
        upsert: true
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
    const extension = file.name.split('.').pop();
    const path = `avatars/${userId}_${Date.now()}.${extension}`;
    return this.uploadFile('profiles', path, file);
  }

  async uploadDriverDocument(userId: string, type: string, file: File): Promise<string> {
    const extension = file.name.split('.').pop();
    const path = `documents/${userId}/${type}_${Date.now()}.${extension}`;
    return this.uploadFile('driver-docs', path, file);
  }
}
