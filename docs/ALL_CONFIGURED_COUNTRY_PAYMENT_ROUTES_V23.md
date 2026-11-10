# Automatic Settings country payment assignments

Creates card-provider preferences for all countries saved under system_configs countries. Existing preferred assignments, merchant identities, approvals and payment bindings are preserved. New assignments remain disabled, unapproved and not adapter-ready.

Current saved list: Kora for Nigeria, Ghana, Kenya and South Africa; Stripe for Australia, Belgium, Canada, France, Germany, India, Ireland, Italy, Netherlands, New Zealand, Portugal, Spain, United Arab Emirates, United Kingdom and United States.

Recommendations are routing preferences, not a guarantee of merchant acceptance or transaction capability. The Kora regional preference covers NG, GH, KE, ZA, TZ, EG, CM, CI and SN with the configured fiat currency options. Other configured countries receive a Stripe preference when their currency appears in the supplied Stripe catalog. Unsupported currencies remain unassigned for review. Stablecoin wallets require separate network-specific integration.

An AFTER INSERT/UPDATE trigger on the countries setting creates missing country/currency/card preferences. Manual preferences win. Currency changes add a new pair; removing a country retains historical routes. This patch does not change Settings access permissions, activate markets, enable payments, install execution adapters, add frontend badges or deploy API code.

The initial migration requires every currently saved country to receive an assignment and asserts existing route rows are unchanged. Subsequent unsupported additions remain visible as unassigned in country_payment_assignments_v23. That view is service-only and omits merchant account references.

Validation: SQL and PL/pgSQL syntax parsed locally. Run scripts/check-all-country-payment-routes-v23.sql after migration for actual database state tests. It copies installed functions and tables to an uncommitted schema and rolls back synthetic tests of Settings-trigger mapping, preserved approvals, manual preferences, currency changes, retired routes and invalid settings. No provider requests are made. This does not verify production provider capabilities.

Apply to movabi_develop only, following a database backup. Current Kora sandbox and legacy Stripe execution limitations remain in force. The API must separately be deployed with the previously tested database-routing implementation before it uses these assignments.
