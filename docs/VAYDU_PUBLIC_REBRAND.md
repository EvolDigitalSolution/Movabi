# Vaydu public branding

This release changes displayed Movabi wording to Vaydu across mobile, admin, email, push, support, wallet labels, PWA metadata and Android/iOS display and permission labels. No business logic, fares, commissions or booking records are migrated.

## Compatibility identifiers retained

Keep com.movabi.app package/bundle IDs and deep-link schemes, MovabiWalletProvisioning native plugin registration, X-Movabi-Journey-Token, movabi_pay database fields, local/session storage keys, CSS selectors, Angular component names, about-movabi routes, asset filenames, environment variable names, domains, email addresses, Stripe metadata/idempotency keys, Docker services and database names. These are integration contracts, not displayed brand names. Do not run a repository-wide replace.

Stripe issuing cardholder fallback identity/billing strings are intentionally preserved; this patch does not change registered or verified identity information.

## Deployment and external configuration

Build/release both API and mobile web to align notifications and email with the UI. Build admin separately when deploying admin. Native installed app names/permission messages require a new Android/iOS build; a web deployment cannot update native metadata. Keep signing credentials and application IDs. No database migration is included.

Existing database-configured update titles, market messages, carousel copy and historical notifications/support messages can still contain Movabi. Review editable current configuration in admin; preserve historical booking/payment evidence. Also review Supabase auth email templates, OneSignal app display names, OAuth consent branding, Stripe business/public receipt branding and store metadata in their respective dashboards. Do not change webhook secrets, callback URLs or verified business identity as part of a display rename. Existing working domains and support email addresses remain valid.

The existing car icon is retained. No new logo is supplied. Some binary/native splash assets in the supplied source snapshot could not be decoded; verify installed launch screens in the native checkout before release.

Name selection is the owner's decision; this change does not constitute trademark clearance or domain registration.
