export type JobMessageType = 'quick' | 'text' | 'system';

export interface JobMessage {
  id: string;
  tenant_id: string;
  job_id: string;
  sender_id: string;
  receiver_id: string;
  message: string;
  message_type: JobMessageType;
  read_at?: string;
  created_at: string;
}

export interface QuickMessageOption {
  label: string;
  message: string;
}

export const QUICK_MESSAGES: QuickMessageOption[] = [
  { label: "I'm outside", message: "I'm outside" },
  { label: "On my way", message: "On my way" },
  { label: "Running late", message: "Running late" },
  { label: "Arrived", message: "Arrived" },
  { label: "Please call me", message: "Please call me" }
];
