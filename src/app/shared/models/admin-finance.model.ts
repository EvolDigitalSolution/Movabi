export interface FinanceBooking {
  id: string; tenantId: string; country: string; currency: string;
  completedAt: string; paymentMethod: string; paymentStatus: string;
  customerPayments: number; commission: number; platformFee: number; platformIncome: number;
  driverEarnings: number; serviceRefunds: number; splitValid: boolean;
  transferStatus: string; transferId: string | null;
}
export interface FinancePayout {
  id: string; country: string; currency: string; amount: number; status: string; error: string | null;
}
export interface FinanceReport {
  date: string; timezone: string; generatedAt: string; undatedCompletedCount: number;
  bookings: FinanceBooking[]; outstandingPayouts: FinancePayout[];
}
