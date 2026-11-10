export interface DriverIdentityEditability {
  dateOfBirthEditable:boolean;
  fullNameEditable:boolean;
  countryCodeEditable:boolean;
  reason:string|null;
  fullNameReason:string|null;
  countryCodeReason:string|null;
}

export interface DobCorrectionPermission {
  status?:string|null;
  request_type?:string|null;
  permission_consumed_at?:string|null;
}

export class DriverIdentityEditabilityService {
  static resolve(profile:Record<string,unknown>,requests:DobCorrectionPermission[]=[]):DriverIdentityEditability {
    const correctionAllowed=requests.some(request=>request.request_type==='identity_correction'&&request.status==='approved'&&!request.permission_consumed_at);
    const status=String(profile.driver_review_status||profile.verification_status||'').toLowerCase();
    const submitted=profile.onboarding_completed===true||['pending','under_review','action_required','approved','paused','rejected','ready_for_admin_review'].includes(status);
    const verified=profile.is_verified===true||status==='approved';

    const dateOfBirthEditable=correctionAllowed
      ?true
      :!submitted;
    const fullNameEditable=!verified;
    const countryCodeEditable=!verified;

    return {
      dateOfBirthEditable,
      fullNameEditable,
      countryCodeEditable,
      reason: correctionAllowed
        ?'An administrator has allowed a date of birth correction.'
        :(submitted?'Date of birth cannot be changed after verification has started.':null),
      fullNameReason: verified
        ?'Your legal name is tied to your verified driver identity. Contact support to request a name change.'
        :null,
      countryCodeReason: verified
        ?'Your operating country is tied to your verified driver identity. Contact support to request a change.'
        :null
    };
  }
}
