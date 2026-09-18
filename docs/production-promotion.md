# Elf Vault Production Promotion

Elf Vault production deployment is human-gated. It never runs automatically on a
push, tag, or staging deployment.

## Preconditions

1. The candidate is a full 40-character Git SHA and is the current Forgejo
   `main` commit.
2. The staging deployment completed successfully for that SHA.
3. `scripts/release/preflight-production.mjs` proves the candidate SHA on
   `https://staging.api.vault.elf.dance/healthcheck`, verifies
   `/build-provenance.json` on `https://staging.vault.elf.dance/`, and checks
   the retained `pad*.ch5.me` compatibility hosts.

## Promotion

Dispatch `.forgejo/workflows/promote-production.yml` and enter the candidate in
the `candidate_sha` field. The workflow checks out that exact commit, repeats
the current-main and staging proofs, and only then unlocks the production Hush
target.

The deployment applies production D1 migrations, deploys the Worker with the
candidate SHA as `VERSION` and `HQ_RELEASE`, builds the production PWA from the
same checkout, emits `elf-vault.pwa-provenance.v1`, and deploys it to Cloudflare
Pages. The workflow finishes with API, PWA, CSP, CORS, asset, brand, and
old-host canaries on `https://api.vault.elf.dance/` and
`https://vault.elf.dance/`.

## Security Boundary

-   Forgejo stores only `SOPS_AGE_KEY`; Cloudflare credentials remain in the
    stage-specific `wrangler-deploy-production` Hush target.
-   An arbitrary branch, shortened SHA, stale staging candidate, or non-current
    `main` commit fails before production credentials are loaded.
-   `scripts/deploy-production` repeats the same preflight before its production
    Hush invocation, so the direct entrypoint cannot mutate production without
    current-main and exact staging provenance proof.

## Residual Limitation

Cloudflare Worker and Pages output is rebuilt from the exact staging-verified
source commit. The repository does not yet publish an immutable combined
Worker/Pages artifact that Cloudflare can promote without rebuilding. Until such
an adapter exists, exact checkout, exact injected version, staging equivalence,
and post-deploy canaries are the enforced reproducibility boundary.
