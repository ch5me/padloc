# Production Promotion

CH5 Auth production deployment is human-gated. It never runs automatically on a
push, tag, or staging deployment.

## Preconditions

1. The candidate is a full 40-character Git SHA and is the current Forgejo
   `main` commit.
2. The staging deployment completed successfully for that SHA.
3. `https://api-pad-staging.ch5.me/healthcheck` reports the candidate SHA and
   `https://pad-staging.ch5.me/` passes its canary.

## Promotion

Dispatch `.forgejo/workflows/promote-production.yml` and enter the candidate in
the `candidate_sha` field. The workflow checks out that exact commit, repeats
the current-main and staging proofs, and only then unlocks the production Hush
target.

The deployment applies production D1 migrations, deploys the Worker with the
candidate SHA as `VERSION` and `HQ_RELEASE`, builds the production PWA from the
same checkout, and deploys it to Cloudflare Pages. The workflow finishes by
checking the production API's exact SHA and the production PWA response.

## Security Boundary

-   Forgejo stores only `SOPS_AGE_KEY`; Cloudflare credentials remain in the
    stage-specific `wrangler-deploy-production` Hush target.
-   An arbitrary branch, shortened SHA, stale staging candidate, or non-current
    `main` commit fails before production credentials are loaded.
-   Do not run `scripts/deploy-production` directly for routine promotion. Its
    SHA checks reduce mistakes, but only the workflow proves current `main` and
    live staging state.

## Residual Limitation

Cloudflare Worker and Pages output is rebuilt from the exact staging-verified
source commit. The repository does not yet publish an immutable combined
Worker/Pages artifact that Cloudflare can promote without rebuilding. Until such
an adapter exists, exact checkout, exact injected version, staging equivalence,
and post-deploy canaries are the enforced reproducibility boundary.
