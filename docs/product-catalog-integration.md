# Firefly product catalog integration

Firefly/ELF owns the CH5 product catalog and marketing presentation. CH5 Auth
owns release metadata and artifacts in this repository. The integration contract
is the strict manifest, not copied download links.

The Firefly product page should consume:

-   staging pointer:
    `https://git.ch5.me/ch5/padloc/releases/download/staging-latest/latest.json`
-   stable pointer:
    `https://git.ch5.me/ch5/padloc/releases/download/stable-latest/latest.json`
-   immutable release manifests and artifact URLs discovered from either
    pointer.

The consumer must validate schema version, product id, SemVer, SHA, channel,
checksums, sizes, and allowed URL hosts. A failed or invalid fetch renders a
safe "downloads unavailable" state. The product page owns the overview, current
and legacy downloads, supported-platform matrix, installation/update/rollback,
security, privacy, license, support, and source links.

The audited Firefly checkout was dirty with unrelated work, so this repository
records the finalized integration contract without editing that unsafe worktree.
A clean Firefly topic branch should add a generic manifest parser and a
dedicated `/products/ch5-auth` route after the first staging pointer is live.
