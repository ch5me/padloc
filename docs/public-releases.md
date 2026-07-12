# Public Releases

CH5 Auth separates CI proof, staging downloads, stable downloads, and store
distribution. Forgejo is the private release ledger. Anonymous artifacts and
machine-readable channel pointers are served from the stage's Worker-backed R2
release namespace; website/catalog consumers must read those manifests rather
than copy artifact URLs.

## Channels and immutability

-   `staging`: automatically published only from the exact current `main` SHA
    after its release checks pass. Staging artifacts are development builds and
    may be unsigned.
-   `stable`: human promotion only. The candidate must be the current `main`
    SHA, must already have an immutable staging manifest, and must pass download
    and checksum canaries. Stable tags and version assets are never replaced.
-   Immutable records use `release-v<version>-<sha>` tags. Moving channel
    pointers use the dedicated `staging-latest` and `stable-latest` releases.

Release notes are generated from commits since the previous stable tag into a
categorized draft. A human must edit and approve the draft before stable
promotion; file diffs are not treated as user-visible release notes.

## Support truth

`config/platform-support.json` is the reviewed support matrix. The only initial
durable staging download is the unsigned web-extension ZIP. It is suitable for
developer installation, not a browser-store claim. Windows has no documented
owned runner. iOS/store distribution, macOS signing/notarization, and native
passkey release readiness are not claimed. Gate 7 in
`docs/adr-passkey-native-vault-boundary.md` remains a release blocker.

## Retention and withdrawal

-   Stable manifests and security-relevant releases are retained indefinitely.
-   The current and previous supported stable binaries remain readily available.
-   Older releases move to legacy presentation with their support status; they
    are not silently deleted.
-   Staging releases may be pruned after 90 days, except the current staging
    candidate and any candidate referenced by a stable release.
-   A compromised artifact is withdrawn by removing it from channel pointers and
    publishing a signed withdrawal notice that names its version, SHA, checksum,
    reason, and replacement. The immutable ledger remains for audit unless legal
    or active-exploitation risk requires restricted access.
-   Rollback moves `stable/latest.json` to a previous known-good immutable
    manifest; it never rebuilds or changes that version's bytes.

## Human production action

Stable publication and the existing Cloudflare production deployment are
separate human-gated actions. Neither may be inferred from a green staging job.
The production Worker version that serves `/public-releases/` must be deployed
through the separate production gate before stable promotion can pass its
anonymous download canary.
