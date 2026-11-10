# Vaydu brand mark

Use the approved connected V in amber on navy as the shared brand mark. Service-specific cars, parcels and other illustrations belong inside service features, not in the app identity.

- Canonical app-icon source: `resources/icon-source.png` (1024 × 1024).
- Shared UI asset: `public/assets/brand/vaydu-icon.png`.
- Colours: navy `#07152F`, amber `#F59E0B`.
- Keep the master square and unmasked; the operating system supplies icon masks.
- Keep existing internal app IDs, URL paths and Android resource IDs stable.
- Do not modify payment provider behaviour or market eligibility as part of branding.

Android launcher densities, adaptive icon XML, splash images and the monochrome notification mark are included. To regenerate iOS assets from the same masters, run `npx capacitor-assets generate --ios --assetPath resources` in the repository after installing dependencies. Run `npx cap sync android` after the web build to copy updated web assets into Android; this does not build an APK or publish the app.

The source SVG is an SVG wrapper around the approved raster master; it is not an independently redrawn vector logo.
