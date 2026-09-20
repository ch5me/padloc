# Native Messaging Host Manifest — Source of Truth

Origin: `magic-browser` `docs/plans/magic-browser-multitenant-cloud-ralplan.md` G014.

## What this is

Chrome's native-messaging protocol requires a manifest file at an OS-specific path (on the
Firecracker guest: `/etc/chromium/native-messaging-hosts/dance.elf.vault.json`) naming the host
binary, its invocation type, and which extension origins may talk to it. Until 2026-07-25 this
manifest was **hand-authored directly inside `magic-browser`'s
`scripts/firecracker/build-guest-image`** as an inline heredoc, with no counterpart or
cross-reference in this repo at all.

The canonical files now live here:

- `packages/extension/native-host/manifest/dance.elf.vault.json` — the manifest itself.
- `packages/extension/native-host/manifest/dance.elf.vault-wrapper.sh` — the shell entry point
  Chrome execs (installed at `/usr/local/bin/dance.elf.vault`), which in turn execs
  `packages/extension/native-host/elf-vault-autofill-host.mjs` via Node.

`magic-browser` should copy these two files verbatim into a guest image rather than re-authoring
their contents. **This is not yet wired** — `build-guest-image` still contains its own inline
copies. Rewiring it belongs to the guest-image rebuild in
`magic-browser-multitenant-cloud-ralplan.md` G008 (which is already collapsing several other
guest-image `sed`-patches into one rebuild), not to a piecemeal edit of the currently-pinned image
build script.

## Stable extension identity and native messaging

`packages/extension/src/manifest.json` now carries a retained public signing key. Chrome derives
the stable extension ID `hjlpcicmbdhndefnlekcmcednbbgldmp` from that key, independent of the
unpacked install path or the hosted CRX path. The native host manifest keeps the two historical
IDs for already-installed development builds and adds the retained ID for signed/managed
installs.

The private key is provisioned only in Padloc Hush as
`PADLOC_EXTENSION_SIGNING_KEY` under `env/project/shared`. Never commit it, print it, or copy it
into a browser profile. If the key is replaced, the extension ID changes and the native host
allowlist plus every Chrome Enterprise policy must be updated as one coordinated migration.

`magic-browser` must copy this repo's native host manifest into guest images rather than
re-authoring a second allowlist. Keep the guest-image install path independent of extension
identity; the retained manifest key is now the source of truth.

## Signed CRX and update manifest

The local distribution lane is:

```sh
PL_SERVER_URL=https://api-pad.ch5.me npm run web-extension:build
PADLOC_EXTENSION_UPDATE_URL=https://mb-extensions.ch5.me/elf-vault/elf-vault-extension-4.3.0.crx \
PADLOC_EXTENSION_CRX=.ch5/artifacts/elf-vault-extension-4.3.0.crx \
PADLOC_EXTENSION_UPDATE_MANIFEST=.ch5/artifacts/elf-vault/updates.xml \
npm run web-extension:package:distribution
```

The `elf-vault/` path is intentionally distinct from Magic Browser's artifacts when sharing the
same HTTPS host. The packager validates the manifest key, derives the stable ID, signs through the
existing CRX packer, and emits Chrome update XML. It reads the private key through Hush and
deletes its temporary key file before returning. Hosting and Admin Console policy remain separate
deployment steps; this lane does not publish or mutate managed browsers.
