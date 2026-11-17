// Payout eligibility stub: the rehearsal simulates the provider boundary, and
// the fixture driver has no real connected Stripe account. Eligibility is not
// the behaviour under test (claim -> reconcile -> transfer -> finish is).
module.exports.PayoutEligibilityService = class {
  static async assertEligible() { return { eligible: true }; }
};
module.exports.PayoutEligibilityError = class PayoutEligibilityError extends Error {
  constructor(code, message) { super(message); this.code = code; }
};
module.exports.SUPPORTED_PAYOUT_COUNTRIES = ['GB'];
