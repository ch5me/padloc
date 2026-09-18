# Elf Vault Rebrand Test Specification

- Runtime target checker rejects stage mismatch, invalid HTTPS origins, app/API host collisions,
  and Wrangler/target-map disagreement.
- Customer-surface scan validates canonical brand and domains while allowlisting internal and
  legacy compatibility identifiers.
- PWA production builds for staging and production contain the exact app/API hosts, Elf Vault
  title/manifest/icon, resolved CSP placeholders, no old current-product domains, and no source maps.
- PWA artifacts contain candidate-SHA provenance and published content hashes; old/new host service
  workers register with origin-safe CSP.
- Worker header tests cover old/new allowed origins and an unknown denied origin, including OPTIONS
  and `Vary: Origin`.
- Email-template check proves generated templates match assets and render Elf Vault links.
- Extension source/dist preflight proves Elf Vault branding without changing native bridge IDs.
- Local `ch5-svc` API/web/maildev remains serving.
- Staging/production canary validates exact SHA, health, PWA HTML/manifest/favicon/service worker,
  CSP, content types, brand, CORS, and old-host compatibility.
- Old-origin application smoke proves load, unlock, and sync—not only HTTP 200.
- Direct production deploy rejects a candidate that is not current `origin/main` or lacks matching
  staging health proof before production auth or mutation.
