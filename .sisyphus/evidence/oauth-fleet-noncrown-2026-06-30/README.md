# OAuth Fleet Non-Crown Passkey Evidence - 2026-06-30

Scope: non-Crown Google accounts only. Crown lane/account untouched.

## Browser Lanes

- Zack: Chrome for Testing CDP `127.0.0.1:9831`, PID `57744`, profile `/Users/hassoncs/.browser-profiles/magic-browser-noncrown-zack-20260630`.
- Blue: Chrome for Testing CDP `127.0.0.1:9832`, PID `59793`, profile `/Users/hassoncs/.browser-profiles/magic-browser-noncrown-blue-20260630`.
- Generic RP: Chrome for Testing CDP `127.0.0.1:9834`, PID `22673`, profile `/Users/hassoncs/.browser-profiles/magic-browser-padloc-local-rp-20260630`.
- Crown lane observed only for liveness, not mutated: CDP `127.0.0.1:9821`, PID `5246`, profile `/Users/hassoncs/.browser-profiles/magic-browser-crown-google`.

## Current Google State

- Zack old credential: `iCloud Keychain (Jun 29, 2026, 9:43:10 PM)`, created `Yesterday, 9:43 PM`, last used `Yesterday, 10:29 PM`, security-delay copy visible.
- Blue old credential: `iCloud Keychain (Jun 29, 2026, 10:42:25 PM)`, created `Yesterday, 10:42 PM`, last used `Yesterday, 10:48 PM, Chrome on Mac`, security-delay copy visible.
- Old fresh-login retests reached Google pk/error with Bluetooth proximity copy. Treat as inconclusive for Google policy because cloned Padloc assertion state was unavailable.
- 2026-06-30 current state rerun without Google passwords could not inventory passkey pages: both Zack and Blue redirected to Google sign-in identifier and were recorded as `blocked_google_reauth`.
- 2026-06-30 fresh-login probes after Google-only cookie/origin clear reached Google `challenge/pk/error` for both Zack and Blue with Padloc hooks active. No Google password, native chooser, Touch ID, or Mac password path was used.

## Patched Identity Shape

- Product name for this temporary identity: `Padloc Agentic Vault / Elf Vault temporary identity`.
- AAGUID: `7a46cc38-26d9-47fe-9f3b-b52837c6020d`.
- Registration flags: `0x5d` (`UP`, `UV`, `BE`, `BS`, `AT`).
- Sign count: `0`.
- Attestation: `fmt=none`.
- Attachment: `platform`.
- Transports: `internal`.
- `credProps.rk`: `true`.

## Patched Zack Result

- Re-enroll succeeded after extension rebuild and storage reset for Zack only.
- Google label changed to `Passkey (Jun 30, 2026, 10:02:28 AM)`.
- Created: `Just now`.
- Last used: `Not yet used`.
- Fresh login after Google-only storage clear preserved Padloc extension storage and signer IndexedDB.
- Login stopped at Google password-only chooser: `Enter your password` / `Try another way`.
- Helper status: `blocked_google_password_required_no_passkey_offer`.
- Hooks stayed active: `createHooked=true`, `getHooked=true`.
- No native chooser, Touch ID, or `2-Step Verification only security key` text appeared in the patched Zack login proof.

## External RP Result

- Deterministic local RP proof passed on the generic CFT lane with real server-side registration and authentication verification.
- Local RP registration verified challenge, origin, RP ID hash, AAGUID, flags, sign count, `fmt=none`, COSE ES256 public key, `transports=["internal"]`, `authenticatorAttachment="platform"`, and `credProps.rk=true`.
- Local RP authentication verified challenge, origin, RP ID hash, credential ID, UP/UV/BE/BS flags, sign count increment, and assertion signature with the registration public key.
- Fresh `webauthn.io` proof passed on the generic CFT lane after deleting only stale `webauthn.io` test passkey items from that Padloc test vault. The public RP completed register plus login and showed `You're logged in!`.
- The credential provider metadata showed AAGUID `7a46cc38-26d9-47fe-9f3b-b52837c6020d`.
- Transports showed `["internal"]`.
- Helper status: `webauthn-io-proof`, `ok=true`, stage `complete`, `registerSuccess=true`, `loginSuccess=true`.
- Latest rerun: `webauthn-io-proof-rerun-2026-06-30.json`, after hardening the helper
  to use an email-shaped WebAuthn.io username and scoped error text.
- Final rerun: `webauthn-io-proof-final-2026-06-30.json`, after hardening the helper to avoid profile-state false positives, survive WebAuthn.io navigation, and clear stale same-RP test credentials before the fresh proof.
- Repeat rerun: `webauthn-io-proof-repeat-2026-06-30.json`, passed with `--preserve-rp-passkeys=true` against the already-created public-RP credential state.
- Secondary public RP attempt: `webauthn.me` loaded with hooks active, but its tutorial controls never attached in the CFT lane; saved as `webauthn-me-proof-2026-06-30.json`, `ok=false`, blocker `timed out waiting for webauthn.me tutorial handlers`.
- This proves the patched Padloc WebAuthn create/get path works on a deterministic RP and a non-Google public relying party. It does not replace the Google-specific policy/risk proof.

## Evidence Files

- `passkey-registration-shape.json`: decoded Padloc registration shape after identity patch.
- `zackattacktucker/google-passkey-state.json`: old Zack passkey page inventory.
- `zackattacktucker/google-passkey-login.json`: old Zack fresh-login retest.
- `hassongoblue/google-passkey-state.json`: old Blue passkey page inventory.
- `hassongoblue/google-passkey-login.json`: old Blue fresh-login retest.
- `zackattacktucker-patched/google-passkey-enroll.json`: patched Zack enrollment and Google label.
- `zackattacktucker-patched/google-passkey-login.json`: patched Zack fresh-login result.
- `zackattacktucker-patched/google-passkey-state.json`: current sign-in/reauth blocker after passwordless-only state attempt.
- `hassongoblue/google-passkey-login.json`: current fresh-login retest, Google `challenge/pk/error` with hooks active.
- `hassongoblue/google-passkey-state.json`: current sign-in/reauth blocker after passwordless-only state attempt.
- `local-rp-webauthn-proof.json`: deterministic local RP registration/assertion proof with server-side signature verification.
- `webauthn-io-proof.json`: public WebAuthn.io external-RP proof through the Padloc extension hook.
- `webauthn-io-proof-rerun-2026-06-30.json`: repeat WebAuthn.io proof after helper hardening.
- `webauthn-io-proof-final-2026-06-30.json`: fresh WebAuthn.io register/login proof after local RP verifier landed.
- `webauthn-io-proof-repeat-2026-06-30.json`: repeat WebAuthn.io login proof against the already-created public-RP credential.
- `webauthn-me-proof-2026-06-30.json`: second public RP attempt and site-specific blocker.

Screenshots in this folder were redacted in-page before capture.
