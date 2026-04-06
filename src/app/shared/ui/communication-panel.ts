import { Component, Input, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { CommunicationService } from '@core/services/communication/communication.service';
import { AuthService } from '@core/services/auth/auth.service';
import { QUICK_MESSAGES, JobMessage } from '@shared/models/communication.model';
import { ButtonComponent } from './button';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-communication-panel',
  standalone: true,
  imports: [CommonModule, IonicModule, ButtonComponent, FormsModule],
  template: `
    <div class="flex flex-col h-full bg-white rounded-t-3xl shadow-2xl border-t border-gray-100 overflow-hidden">
      <!-- Header -->
      <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0 z-10">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <ion-icon name="chatbubbles" class="text-xl"></ion-icon>
          </div>
          <div>
            <h3 class="text-sm font-bold text-text-primary tracking-tight">Communication</h3>
            <p class="text-[10px] text-text-secondary uppercase font-bold tracking-widest">Active Job</p>
          </div>
        </div>
        
        @if (receiverPhone) {
          <app-button variant="secondary" size="sm" [fullWidth]="false" (onClick)="callReceiver()">
            <ion-icon name="call" class="mr-1"></ion-icon>
            Call
          </app-button>
        }
      </div>

      <!-- Messages Thread -->
      <div class="flex-1 overflow-y-auto p-6 space-y-4 min-h-[200px] max-h-[400px] bg-gray-50/50" #scrollContainer>
        @if (messages().length === 0) {
          <div class="flex flex-col items-center justify-center py-8 text-center opacity-50">
            <ion-icon name="chatbubble-outline" class="text-3xl mb-2"></ion-icon>
            <p class="text-xs font-medium">No messages yet</p>
          </div>
        }

        @for (msg of messages(); track msg.id) {
          <div [class]="'flex ' + (isMe(msg.sender_id) ? 'justify-end' : 'justify-start')">
            <div [class]="'max-w-[80%] rounded-2xl px-4 py-2 text-sm ' + 
              (isMe(msg.sender_id) 
                ? 'bg-primary text-white rounded-tr-none' 
                : 'bg-white text-text-primary border border-gray-200 rounded-tl-none')">
              <p>{{ msg.message }}</p>
              <p [class]="'text-[8px] mt-1 opacity-70 ' + (isMe(msg.sender_id) ? 'text-right' : 'text-left')">
                {{ msg.created_at | date:'HH:mm' }}
              </p>
            </div>
          </div>
        }
      </div>

      <!-- Quick Messages -->
      <div class="px-4 py-3 border-t border-gray-100 bg-white">
        <div class="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          @for (option of quickMessages; track option.label) {
            <button 
              (click)="sendQuick(option.message)"
              class="whitespace-nowrap px-4 py-2 rounded-full bg-gray-100 text-text-primary text-xs font-bold hover:bg-primary/10 hover:text-primary transition-colors border border-transparent active:scale-95"
            >
              {{ option.label }}
            </button>
          }
        </div>
      </div>

      <!-- Input Area -->
      <div class="p-4 bg-white border-t border-gray-100">
        <div class="flex items-center gap-2 bg-gray-100 rounded-2xl px-4 py-2 focus-within:ring-2 focus-within:ring-primary/20 transition-all">
          <input 
            type="text" 
            [(ngModel)]="textMessage" 
            (keyup.enter)="sendText()"
            placeholder="Type a message..." 
            class="flex-1 bg-transparent border-none focus:outline-none text-sm text-text-primary py-2"
          />
          <button 
            (click)="sendText()"
            [disabled]="!textMessage.trim()"
            class="w-10 h-10 rounded-xl bg-primary text-white flex items-center justify-center disabled:opacity-50 disabled:grayscale active:scale-90 transition-all"
          >
            <ion-icon name="send" class="text-lg"></ion-icon>
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .scrollbar-hide::-webkit-scrollbar {
      display: none;
    }
    .scrollbar-hide {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
  `]
})
export class CommunicationPanelComponent implements OnInit, OnDestroy {
  @Input({ required: true }) jobId!: string;
  @Input({ required: true }) receiverId!: string;
  @Input() receiverPhone?: string;

  private commService = inject(CommunicationService);
  private auth = inject(AuthService);
  
  messages = signal<JobMessage[]>([]);
  quickMessages = QUICK_MESSAGES;
  textMessage = '';
  currentUserId = signal<string | null>(null);
  private messagesSub?: Subscription;

  ngOnInit() {
    const user = this.auth.currentUser();
    if (user) this.currentUserId.set(user.id);

    this.commService.getJobMessages(this.jobId);
    this.commService.subscribeToJobMessages(this.jobId);
    
    this.messagesSub = this.commService.messages$.subscribe(msgs => {
      this.messages.set(msgs);
      setTimeout(() => this.scrollToBottom(), 100);
    });
  }

  ngOnDestroy() {
    this.commService.unsubscribeFromJobMessages();
    this.messagesSub?.unsubscribe();
  }

  isMe(senderId: string): boolean {
    return senderId === this.currentUserId();
  }

  async sendQuick(message: string) {
    try {
      await this.commService.sendQuickMessage(this.jobId, this.receiverId, message);
    } catch (e) {
      console.error('Failed to send quick message', e);
    }
  }

  async sendText() {
    if (!this.textMessage.trim()) return;
    const msg = this.textMessage.trim();
    this.textMessage = '';
    
    try {
      await this.commService.sendMessage(this.jobId, this.receiverId, msg);
    } catch (e) {
      console.error('Failed to send text message', e);
    }
  }

  callReceiver() {
    if (this.receiverPhone) {
      window.open(`tel:${this.receiverPhone}`, '_system');
    }
  }

  private scrollToBottom() {
    const container = document.querySelector('.overflow-y-auto');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }
}
