/**
 * Pure inspection progress (no imports: also bundled into the admin app through
 * DriverRequirementService). Loading the evidence from the database lives in
 * driver-inspection-evidence.ts (server only).
 */
export interface InspectionEvidence {
  /** A saved vehicle exists (photos belong to a vehicle and its inspection revision). */
  vehicle: boolean;
  bike: boolean;
  requiredSlots: string[];
  photos: Array<{slot: string; status: string}>;
}
export type InspectionSlotState = 'missing' | 'rejected' | 'awaiting_review' | 'approved';
export interface InspectionProgress {
  required: number; uploaded: number; approved: number;
  missing: string[]; rejected: string[]; awaitingReview: string[];
  uploadsComplete: boolean; approvalComplete: boolean;
  slots: Record<string, InspectionSlotState>;
}

const RANK: Record<string, number> = {approved: 4, under_review: 3, uploaded: 3, rejected: 2, replacement_required: 2};

export function inspectionProgress(evidence: InspectionEvidence): InspectionProgress {
  const slots: Record<string, InspectionSlotState> = {};
  for (const slot of evidence.requiredSlots) {
    // The best current photo for the slot; replaced rows are never loaded or counted.
    const best = evidence.photos.filter(p => p.slot === slot && RANK[p.status] !== undefined)
      .sort((a, b) => RANK[b.status] - RANK[a.status])[0];
    slots[slot] = !best ? 'missing' : best.status === 'approved' ? 'approved'
      : best.status === 'rejected' || best.status === 'replacement_required' ? 'rejected' : 'awaiting_review';
  }
  const of = (state: InspectionSlotState) => evidence.requiredSlots.filter(slot => slots[slot] === state);
  const missing = of('missing'), rejected = of('rejected'), awaitingReview = of('awaiting_review'), approved = of('approved');
  const required = evidence.requiredSlots.length;
  const uploaded = awaitingReview.length + approved.length;
  return {
    required, uploaded, approved: approved.length, missing, rejected, awaitingReview,
    uploadsComplete: evidence.vehicle && required > 0 && uploaded === required,
    approvalComplete: evidence.vehicle && required > 0 && approved.length === required,
    slots,
  };
}

