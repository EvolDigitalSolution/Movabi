export interface DriverIdentityEditability {
  dateOfBirthEditable:boolean;
  reason:string|null;
}

export interface DobCorrectionPermission {
  status?:string|null;
  request_type?:string|null;
  permission_consumed_at?:string|null;
}

export class DriverIdentityEditabilityService {
  static resolve(profile:Record<string,unknown>,requests:DobCorrectionPermission[]=[]):DriverIdentityEditability {
    const correctionAllowed=requests.some(request=>request.request_type==='identity_correction'&&request.status==='approved'&&!request.permission_consumed_at);
    if(correctionAllowed)return{dateOfBirthEditable:true,reason:'An administrator has allowed a date of birth correction.'};
    const status=String(profile.driver_review_status||profile.verification_status||'').toLowerCase();
    const submitted=profile.onboarding_completed===true||['pending','under_review','action_required','approved','paused','rejected','ready_for_admin_review'].includes(status);
    return submitted
      ?{dateOfBirthEditable:false,reason:'Date of birth cannot be changed after verification has started.'}
      :{dateOfBirthEditable:true,reason:null};
  }
}
