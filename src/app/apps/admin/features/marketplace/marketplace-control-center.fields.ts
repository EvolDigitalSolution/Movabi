export const SERVICES = ['ride', 'shop', 'errand', 'delivery', 'van-moving'];

export const NOTIFICATION_CUSTOMER_KEYS = [
  'newJob', 'offerReceived', 'bidReceived', 'counterOffer', 'offerAccepted',
  'offerExpired', 'fareAgreed', 'paymentReceived', 'driverAssigned',
  'driverArrived', 'jobCompleted', 'cancellation'
];

export const NOTIFICATION_DRIVER_KEYS = [
  'newRequest', 'newBid', 'bidAccepted', 'bidExpired', 'counterOffer',
  'fareAgreed', 'paymentReceived', 'jobAssigned', 'pickupReminder',
  'dropoffReminder', 'jobCompleted'
];

export interface MarketplaceFieldOption {
  label: string;
  value: string;
}

export interface MarketplaceFieldDef {
  label: string;
  path: string;
  type: 'number' | 'boolean' | 'text' | 'array' | 'select' | 'json';
  hint?: string;
  options?: MarketplaceFieldOption[];
}

export interface MarketplaceFieldGroup {
  tab: string;
  title: string;
  fields: MarketplaceFieldDef[];
}

function f(label: string, path: string, type: MarketplaceFieldDef['type'], hint?: string, options?: MarketplaceFieldOption[]): MarketplaceFieldDef {
  return { label, path, type, hint, options };
}

function g(tab: string, title: string, fields: MarketplaceFieldDef[]): MarketplaceFieldGroup {
  return { tab, title, fields };
}

const baseGroups: MarketplaceFieldGroup[] = [
  g('commission', 'Commission & Fees', [
    f('Commission %', 'commission.percent', 'number'),
    f('Minimum Fee', 'commission.minFee', 'number'),
    f('Maximum Fee', 'commission.maxFee', 'number'),
    f('Platform Fee %', 'commission.platformFeePercent', 'number'),
  ]),
  g('dynamicPricing', 'Dynamic Pricing', [
    f('Enabled', 'dynamicPricing.enabled', 'boolean'),
    f('Max Surge', 'dynamicPricing.maxSurge', 'number'),
    f('Traffic Multiplier', 'dynamicPricing.trafficMultiplier', 'number'),
    f('Weather Multiplier', 'dynamicPricing.weatherMultiplier', 'number'),
    f('Demand Multiplier', 'dynamicPricing.demandMultiplier', 'number'),
    f('Fuel Multiplier', 'dynamicPricing.fuelMultiplier', 'number'),
    f('Supply Scarcity Multiplier', 'dynamicPricing.supplyScarcityMultiplier', 'number'),
    f('Rain Multiplier', 'dynamicPricing.rainMultiplier', 'number'),
    f('Flood Multiplier', 'dynamicPricing.floodMultiplier', 'number'),
    f('Peak Multiplier', 'dynamicPricing.peakMultiplier', 'number'),
    f('Airport Surcharge', 'dynamicPricing.airportSurcharge', 'number'),
    f('Public Holiday Multiplier', 'dynamicPricing.publicHolidayMultiplier', 'number'),
    f('Event Multiplier', 'dynamicPricing.eventMultiplier', 'number'),
    f('Nearby Driver Discount', 'dynamicPricing.nearbyDriverDiscount', 'number'),
    f('Minimum Fare', 'dynamicPricing.minimumFare', 'number'),
    f('Maximum Fare Cap', 'dynamicPricing.maximumFareCap', 'number'),
    f('Night Multiplier', 'dynamicPricing.nightMultiplier', 'number'),
    f('Time of Day Enabled', 'dynamicPricing.timeOfDayEnabled', 'boolean'),
    f('Demand/Supply Enabled', 'dynamicPricing.demandSupplyEnabled', 'boolean'),
    f('Weather Enabled', 'dynamicPricing.weatherEnabled', 'boolean'),
    f('Traffic Enabled', 'dynamicPricing.trafficEnabled', 'boolean'),
    f('Event Multiplier Enabled', 'dynamicPricing.eventMultiplierEnabled', 'boolean'),
  ]),
  g('negotiation', 'Negotiation', [
    f('Enabled', 'negotiation.enabled', 'boolean'),
    f('Timeout (seconds)', 'negotiation.timeoutSeconds', 'number'),
    f('Max Rounds', 'negotiation.maxRounds', 'number'),
    f('Minimum Services', 'negotiation.minServices', 'array'),
    f('Enabled Services', 'negotiation.enabledServices', 'array'),
    f('Default Services', 'negotiation.defaultServices', 'array'),
  ]),
  g('hybrid', 'Hybrid Negotiation', [
    f('Enabled', 'hybridNegotiation.enabled', 'boolean'),
    f('Max Rounds', 'hybridNegotiation.maxRounds', 'number'),
    f('Timeout (seconds)', 'hybridNegotiation.timeoutSeconds', 'number'),
    f('Max Driver Attempts', 'hybridNegotiation.maxDriverAttempts', 'number'),
    f('Claim Timeout (seconds)', 'hybridNegotiation.claimTimeoutSeconds', 'number'),
    f('Enabled Services', 'hybridNegotiation.enabledServices', 'array'),
    f('Eligible Services', 'hybridNegotiation.eligibleServices', 'array'),
    f('Ride Minimum Distance (km)', 'hybridNegotiation.rideMinimumDistanceKm', 'number'),
    f('Ride Mode', 'hybridNegotiation.rideMode', 'select', undefined, [
      { label: 'Disabled', value: 'disabled' },
      { label: 'Long Distance Only', value: 'long_distance_only' },
      { label: 'All Rides', value: 'all_rides' },
    ]),
    f('Make Offer Enabled', 'hybridNegotiation.makeOfferEnabled', 'boolean'),
    f('Accept Fare Enabled', 'hybridNegotiation.acceptFareEnabled', 'boolean'),
    f('Allow Customer Counter Offer', 'hybridNegotiation.allowCustomerCounterOffer', 'boolean'),
    f('Allow Driver Counter Offer', 'hybridNegotiation.allowDriverCounterOffer', 'boolean'),
    f('Allow Customer Try Another Driver', 'hybridNegotiation.allowCustomerTryAnotherDriver', 'boolean'),
    f('Auto Release On Timeout', 'hybridNegotiation.autoReleaseOnTimeout', 'boolean'),
    f('Auto Release On Driver Offline', 'hybridNegotiation.autoReleaseOnDriverOffline', 'boolean'),
    f('Payment Deadline After Fare Agreement (seconds)', 'hybridNegotiation.paymentDeadlineAfterFareAgreement', 'number'),
    f('Assign Negotiating Driver After Payment', 'hybridNegotiation.assignNegotiatingDriverAfterPayment', 'boolean'),
  ]),
  g('bidding', 'Bidding', [
    f('Enabled', 'bidding.enabled', 'boolean'),
    f('Enabled Services', 'bidding.enabledServices', 'array'),
    f('Timeout (seconds)', 'bidding.timeoutSeconds', 'number'),
    f('Max Bids', 'bidding.maxBids', 'number'),
    f('Default Services', 'bidding.defaultServices', 'array'),
    f('Minimum Bid', 'bidding.minBid', 'number'),
    f('Max Bid % Above Suggested Fare', 'bidding.maxBidPercentageAboveSuggestedFare', 'number'),
    f('Customer Can Choose Driver', 'bidding.customerCanChooseDriver', 'boolean'),
    f('Show Driver ETA', 'bidding.showDriverEta', 'boolean'),
    f('Show Driver Rating', 'bidding.showDriverRating', 'boolean'),
    f('Show Completed Trips', 'bidding.showCompletedTrips', 'boolean'),
    f('Auto Expire Unsuccessful Bids', 'bidding.autoExpireUnsuccessfulBids', 'boolean'),
  ]),
  g('smartMatching', 'Smart Matching', [
    f('Enabled', 'smartMatching.enabled', 'boolean'),
    f('Max Distance (km)', 'smartMatching.maxDistanceKm', 'number'),
    f('Rating Weight', 'smartMatching.ratingWeight', 'number'),
    f('Completion Weight', 'smartMatching.completionWeight', 'number'),
    f('Distance Weight', 'smartMatching.distanceWeight', 'number'),
    f('Response Weight', 'smartMatching.responseWeight', 'number'),
    f('Search Batch Size', 'smartMatching.searchBatchSize', 'number'),
    f('Driver Claim Batch Size', 'smartMatching.driverClaimBatchSize', 'number'),
    f('ETA Weight', 'smartMatching.etaWeight', 'number'),
    f('Acceptance Rate Weight', 'smartMatching.acceptanceRateWeight', 'number'),
    f('Cancellation Rate Weight', 'smartMatching.cancellationRateWeight', 'number'),
    f('Response Time Weight', 'smartMatching.responseTimeWeight', 'number'),
    f('Vehicle Compatibility Weight', 'smartMatching.vehicleCompatibilityWeight', 'number'),
    f('Idle Time Weight', 'smartMatching.idleTimeWeight', 'number'),
    f('Repeat Customer Bonus', 'smartMatching.repeatCustomerBonus', 'number'),
    f('Driver Tier Bonus', 'smartMatching.driverTierBonus', 'number'),
  ]),
  g('payment', 'Payment Rules', [
    f('Card Enabled', 'paymentRules.cardEnabled', 'boolean'),
    f('Wallet Enabled', 'paymentRules.walletEnabled', 'boolean'),
    f('Cash Enabled', 'paymentRules.cashEnabled', 'boolean'),
    f('Manual Capture Enabled', 'paymentRules.manualCaptureEnabled', 'boolean'),
    f('Payment Before Dispatch', 'paymentRules.paymentBeforeDispatch', 'boolean'),
    f('Payment Deadline After Fare Agreement (seconds)', 'paymentRules.paymentDeadlineAfterFareAgreement', 'number'),
    f('Item Budget Reservation Enabled', 'paymentRules.itemBudgetReservationEnabled', 'boolean'),
    f('Item Budget Maximum', 'paymentRules.itemBudgetMaximum', 'number'),
    f('Refund Release Timeout', 'paymentRules.refundReleaseTimeout', 'number'),
    f('Duplicate Payment Intent Protection', 'paymentRules.duplicatePaymentIntentProtection', 'boolean'),
    f('Allowed Payment Statuses For Dispatch', 'paymentRules.allowedPaymentStatusesForDispatch', 'array'),
  ]),
  g('cleanup', 'Cleanup Rules', [
    f('Enabled', 'marketplaceDraftRules.enabled', 'boolean'),
    f('Pending Fare TTL (minutes)', 'marketplaceDraftRules.pendingFareTtlMinutes', 'number'),
    f('Fare Agreed Unpaid TTL (minutes)', 'marketplaceDraftRules.fareAgreedUnpaidTtlMinutes', 'number'),
    f('Negotiation Idle TTL (minutes)', 'marketplaceDraftRules.negotiationIdleTtlMinutes', 'number'),
    f('Cleanup Interval (minutes)', 'marketplaceDraftRules.cleanupIntervalMinutes', 'number'),
    f('Delete Expired Drafts', 'marketplaceDraftRules.deleteExpiredDrafts', 'boolean'),
  ]),
  g('driver', 'Driver Rules', [
    f('Minimum Driver Rating', 'driverRules.minimumDriverRating', 'number'),
    f('Minimum Completed Trips', 'driverRules.minimumCompletedTrips', 'number'),
    f('Required Verification Status', 'driverRules.requiredVerificationStatus', 'select', undefined, [
      { label: 'None', value: 'none' },
      { label: 'Verified', value: 'verified' },
      { label: 'Approved', value: 'approved' },
    ]),
    f('Require Active Vehicle', 'driverRules.requireActiveVehicle', 'boolean'),
    f('Require Stripe Connected', 'driverRules.requireStripeConnected', 'boolean'),
    f('Require Sufficient Wallet', 'driverRules.requireSufficientWallet', 'boolean'),
    f('Maximum Active Negotiations', 'driverRules.maximumActiveNegotiations', 'number'),
    f('Maximum Active Jobs', 'driverRules.maximumActiveJobs', 'number'),
    f('Cooldown After Decline (seconds)', 'driverRules.cooldownAfterDeclineSeconds', 'number'),
    f('Auto Suspend After Repeated Cancellations', 'driverRules.autoSuspendAfterRepeatedCancellations', 'number'),
    f('Allow Favourite Repeat Drivers', 'driverRules.allowFavouriteRepeatDrivers', 'boolean'),
  ]),
  g('emergency', 'Emergency Controls', [
    f('Disable Marketplace Globally', 'emergencyControls.disableMarketplaceGlobally', 'boolean'),
    f('Disable Make Offer', 'emergencyControls.disableMakeOffer', 'boolean'),
    f('Disable Hybrid Negotiation', 'emergencyControls.disableHybridNegotiation', 'boolean'),
    f('Disable Bidding', 'emergencyControls.disableBidding', 'boolean'),
    f('Disable Dynamic Pricing', 'emergencyControls.disableDynamicPricing', 'boolean'),
    f('Disable By Service', 'emergencyControls.disableByService', 'json'),
    f('Force Accept Fare Only', 'emergencyControls.forceAcceptFareOnly', 'boolean'),
    f('Force Normal Booking Flow', 'emergencyControls.forceNormalBookingFlow', 'boolean'),
    f('Disable Card Payments', 'emergencyControls.disableCardPayments', 'boolean'),
    f('Disable Wallet Payments', 'emergencyControls.disableWalletPayments', 'boolean'),
  ]),
  g('marketplace', 'Marketplace Status', [
    f('Marketplace Enabled', 'marketplaceEnabled', 'boolean'),
  ]),
];

const serviceRuleFieldTemplates: Array<{ label: string; key: string; type: MarketplaceFieldDef['type'] }> = [
  { label: 'Enabled', key: 'enabled', type: 'boolean' },
  { label: 'Marketplace Enabled', key: 'marketplaceEnabled', type: 'boolean' },
  { label: 'Negotiation Enabled', key: 'negotiationEnabled', type: 'boolean' },
  { label: 'Bidding Enabled', key: 'biddingEnabled', type: 'boolean' },
  { label: 'Dynamic Pricing Enabled', key: 'dynamicPricingEnabled', type: 'boolean' },
  { label: 'Smart Matching Enabled', key: 'smartMatchingEnabled', type: 'boolean' },
  { label: 'Minimum Distance (km)', key: 'minimumDistanceKm', type: 'number' },
  { label: 'Maximum Distance (km)', key: 'maximumDistanceKm', type: 'number' },
  { label: 'Minimum Fare', key: 'minimumFare', type: 'number' },
  { label: 'Maximum Fare', key: 'maximumFare', type: 'number' },
  { label: 'Payment Before Dispatch', key: 'paymentBeforeDispatch', type: 'boolean' },
  { label: 'Allow Scheduled Jobs', key: 'allowScheduledJobs', type: 'boolean' },
  { label: 'Allow Multi-Stop', key: 'allowMultiStop', type: 'boolean' },
  { label: 'Allow Hourly Booking', key: 'allowHourlyBooking', type: 'boolean' },
];

const notificationRuleFieldTemplates: Array<{ label: string; key: string; type: MarketplaceFieldDef['type'] }> = [
  { label: 'Push Enabled', key: 'pushEnabled', type: 'boolean' },
  { label: 'In-App Enabled', key: 'inAppEnabled', type: 'boolean' },
  { label: 'Sound Enabled', key: 'soundEnabled', type: 'boolean' },
  { label: 'Vibration Enabled', key: 'vibrationEnabled', type: 'boolean' },
  { label: 'Repeat Interval', key: 'repeatInterval', type: 'number' },
  { label: 'Quiet Hours Start', key: 'quietHoursStart', type: 'text' },
  { label: 'Quiet Hours End', key: 'quietHoursEnd', type: 'text' },
];

function buildServiceRules(): MarketplaceFieldGroup[] {
  return SERVICES.map(service => ({
    tab: 'serviceRules',
    title: 'Service Rules - ' + service,
    fields: serviceRuleFieldTemplates.map(t => f(t.label, `serviceRules.${service}.${t.key}`, t.type))
  }));
}

function buildNotificationRules(): MarketplaceFieldGroup[] {
  const groups: MarketplaceFieldGroup[] = [];
  for (const group of ['customer', 'driver'] as const) {
    const keys = group === 'customer' ? NOTIFICATION_CUSTOMER_KEYS : NOTIFICATION_DRIVER_KEYS;
    for (const key of keys) {
      groups.push({
        tab: 'notifications',
        title: `Notifications - ${group} - ${key}`,
        fields: notificationRuleFieldTemplates.map(t => f(t.label, `notificationRules.${group}.${key}.${t.key}`, t.type))
      });
    }
  }
  return groups;
}

export function buildFieldGroups(): MarketplaceFieldGroup[] {
  return [...baseGroups, ...buildServiceRules(), ...buildNotificationRules()];
}
