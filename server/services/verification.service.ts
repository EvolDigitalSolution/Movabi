export type VerificationResult = {
  passed: boolean;
  status: 'passed' | 'failed' | 'manual_required';
  blockers: string[];
  data?: any;
};

export async function checkVehicleRegistration(registrationNumber?: string | null): Promise<VerificationResult> {
  if (!registrationNumber) {
    return {
      passed: false,
      status: 'failed',
      blockers: ['Vehicle registration number is missing.']
    };
  }

  return {
    passed: false,
    status: 'manual_required',
    blockers: ['Vehicle registration requires manual admin review.'],
    data: {
      registrationNumber
    }
  };
}

export async function checkInsurance(hasInsuranceDocument?: boolean): Promise<VerificationResult> {
  if (!hasInsuranceDocument) {
    return {
      passed: false,
      status: 'failed',
      blockers: ['Insurance document is missing.']
    };
  }

  return {
    passed: false,
    status: 'manual_required',
    blockers: ['Insurance document requires manual admin review.']
  };
}

export async function checkCouncilLicence(input: {
  councilName?: string | null;
  councilLicenseNumber?: string | null;
  taxiBadgeNumber?: string | null;
  taxiLicenseExpiry?: string | null;
}): Promise<VerificationResult> {
  const blockers: string[] = [];

  if (!input.councilName) blockers.push('Council name is missing.');
  if (!input.councilLicenseNumber) blockers.push('Council licence number is missing.');
  if (!input.taxiBadgeNumber) blockers.push('Taxi badge number is missing.');
  if (!input.taxiLicenseExpiry) blockers.push('Taxi licence expiry date is missing.');

  if (input.taxiLicenseExpiry) {
    const expiry = new Date(input.taxiLicenseExpiry);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (Number.isNaN(expiry.getTime())) {
      blockers.push('Taxi licence expiry date is invalid.');
    } else if (expiry < today) {
      blockers.push('Taxi licence has expired.');
    }
  }

  if (blockers.length > 0) {
    return {
      passed: false,
      status: 'failed',
      blockers
    };
  }

  return {
    passed: false,
    status: 'manual_required',
    blockers: ['Council licence details supplied. Admin must verify manually.']
  };
}
