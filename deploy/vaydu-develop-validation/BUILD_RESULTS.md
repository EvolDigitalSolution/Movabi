# Build results â€” candidate `35b2590`

Run from the clean frozen snapshot (branch `v2.3`, HEAD `35b259097c9c6a07940695d37bc4a70b6c7b2ea0`), no
uncommitted changes to tracked sources.

| Build | Command | Exit | Output |
|---|---|---|---|
| Mobile (develop) | `npm run build:mobile:develop` | 0 | `dist/mobile` |
| Admin | `npm run build:admin` | 0 | `dist/admin` |
| Server typecheck | `npx tsc --noEmit -p server/tsconfig.json` | 0 (0 errors) | â€” |

Artifact checksums (index files) are in `SHA256SUMS`; full `dist` trees are build
outputs and are not committed. Rebuild from the same SHA to reproduce them.

The bundle packages the 39-step migration manifest (see `UPGRADE_MANIFEST.md`
and `ORDER.txt`) plus the built mobile, admin and API server tree.
