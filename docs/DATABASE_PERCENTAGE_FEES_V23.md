# Database percentage quote fees

Non-GBP quotes use the percentage fee already calculated from marketplace_settings when the source is explicitly marketplace_settings, the mode is percentage, the fixed amount is zero and the percentage is finite in [0,100). Existing bounds and fare reconciliation remain in the pipeline. Currency and country guards remain required.

This avoids treating GBP fixed allowances as other currencies. It does not estimate processor costs: snapshots explicitly record paymentCostStatus=not_estimated and quoteFeePolicy=database_percentage_v1, with no fabricated paymentMargin policy. Payment execution approval, adapters and saved-card capabilities remain unchanged. Configurations outside this supported quote mode continue to require an explicit currency payment-cost policy.

Example using confirmed database settings: NGN service fare 5790, customer platform fee 5%=289.50, total 6079.50; driver commission 15%=868.50, driver payout 4921.50. Processor costs are not estimated by this calculation.

GBP retains its existing payment-cost protection; a fixed-plus-percentage snapshot is used only when an actual protection adjustment is added. Otherwise the original configured fee mode is preserved.

The 13 actual-finalization cases mock the upstream resolved fare and external dependencies, then execute PricingService.resolvePrice and its real reconciliation. They verify five currencies, five unsupported policy configurations, persisted quote totals, GBP behavior, and shopping-budget guards. They do not replace a full database-to-quote integration check.

No database data, credentials, feature flags, staging or deployment is changed by the installer. Adding Nigerian entries to Admin Pricing Rules is a separate migration, pending preservation of all regional pricing semantics.
