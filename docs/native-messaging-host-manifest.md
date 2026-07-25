# Native Messaging Host Manifest — Source of Truth

Origin: `magic-browser` `docs/plans/magic-browser-multitenant-cloud-ralplan.md` G014.

## What this is

Chrome's native-messaging protocol requires a manifest file at an OS-specific path (on the
Firecracker guest: `/etc/chromium/native-messaging-hosts/me.ch5.padloc.json`) naming the host
binary, its invocation type, and which extension origins may talk to it. Until 2026-07-25 this
manifest was **hand-authored directly inside `magic-browser`'s
`scripts/firecracker/build-guest-image`** as an inline heredoc, with no counterpart or
cross-reference in this repo at all.

The canonical files now live here:

- `packages/extension/native-host/manifest/me.ch5.padloc.json` — the manifest itself.
- `packages/extension/native-host/manifest/me.ch5.padloc-wrapper.sh` — the shell entry point
  Chrome execs (installed at `/usr/local/bin/me.ch5.padloc`), which in turn execs
  `packages/extension/native-host/padloc-autofill-host.mjs` via Node.

`magic-browser` should copy these two files verbatim into a guest image rather than re-authoring
their contents. **This is not yet wired** — `build-guest-image` still contains its own inline
copies. Rewiring it belongs to the guest-image rebuild in
`magic-browser-multitenant-cloud-ralplan.md` G008 (which is already collapsing several other
guest-image `sed`-patches into one rebuild), not to a piecemeal edit of the currently-pinned image
build script.

## The `allowed_origins` extension ID is a real fragility — read before touching it

`allowed_origins` pins `chrome-extension://gncmiloofnlojbhlckjniipiglejppho/`. This extension ID
is **not** derived from a `key` field in `packages/extension/src/manifest.json` — there isn't one.
For an unpacked extension (which is how the guest image loads it — `chrome
--load-extension=/opt/magic-browser/extensions/padloc`), Chrome derives a stable ID by hashing the
**absolute filesystem path** the extension is loaded from. The value above is only correct because
every build of the guest image installs the extension at exactly
`/opt/magic-browser/extensions/padloc` — change that install path in any future image work and
this ID silently goes stale, breaking the native-messaging bridge with no build-time signal.

**Nothing in this repo, and nothing in `magic-browser`, currently asserts that the extension's
real loaded ID matches this manifest's `allowed_origins` value.** They are two independently
hand-maintained copies of the same fact today (this file's `.json` plus
`magic-browser`'s image-build heredoc), kept in sync only by whoever remembers to update both.

Two real fixes, either of which should land as part of a future guest-image rebuild rather than
piecemeal here:

1. **Give the extension a fixed `key` field** in `manifest.json`, making its ID deterministic
   regardless of install path — the standard practice for exactly this problem, and how Chrome
   Web Store extensions get stable IDs. Changing this changes the extension's real ID and requires
   updating `allowed_origins` (here) to match, plus re-pinning the guest image — do this as one
   guest-image-rebuild change, not two separate landings that can drift apart mid-flight.
2. Short of that, add a build-time assertion (in whichever repo controls the image build) that
   loads the actual built extension unpacked at the exact install path and confirms Chrome assigns
   it the ID this manifest expects, failing the build loudly if it doesn't.

Until one of those lands, treat this ID as coupled-by-convention, not verified, and never move the
extension's guest install path without updating this manifest in the same change.
