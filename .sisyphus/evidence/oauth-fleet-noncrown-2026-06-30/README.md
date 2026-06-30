# OAuth Fleet Non-Crown Passkey Evidence - 2026-06-30

Scope: non-Crown Google accounts only. Crown lane/account untouched.

## Browser Lanes

- Zack: Chrome for Testing CDP `127.0.0.1:9831`, PID `57744`, profile `/Users/hassoncs/.browser-profiles/magic-browser-noncrown-zack-20260630`.
- Blue: Chrome for Testing CDP `127.0.0.1:9832`, PID `59793`, profile `/Users/hassoncs/.browser-profiles/magic-browser-noncrown-blue-20260630`.
- Crown lane observed only for liveness, not mutated: CDP `127.0.0.1:9821`, PID `5246`, profile `/Users/hassoncs/.browser-profiles/magic-browser-crown-google`.

## Current Google State

- Zack old credential: `iCloud Keychain (Jun 29, 2026, 9:43:10 PM)`, created `Yesterday, 9:43 PM`, last used `Yesterday, 10:29 PM`, security-delay copy visible.
- Blue old credential: `iCloud Keychain (Jun 29, 2026, 10:42:25 PM)`, created `Yesterday, 10:42 PM`, last used `Yesterday, 10:48 PM, Chrome on Mac`, security-delay copy visible.
- Old fresh-login retests reached Google pk/error with Bluetooth proximity copy. Treat as inconclusive for Google policy because cloned Padloc assertion state was unavailable.

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

- `webauthn.io` proof passed on the Zack CFT lane with the actual Padloc extension hook active.
- The public RP profile showed `You're logged in!`.
- The credential provider metadata showed AAGUID `7a46cc38-26d9-47fe-9f3b-b52837c6020d`.
- Transports showed `["internal"]`.
- Helper status: `webauthn-io-proof`, `ok=true`.
- Latest rerun: `webauthn-io-proof-rerun-2026-06-30.json`, after hardening the helper
  to use an email-shaped WebAuthn.io username and scoped error text.
- This proves the patched Padloc WebAuthn create/get path works on a non-Google public relying party. It does not replace the Google-specific policy/risk proof.

## Evidence Files

- `passkey-registration-shape.json`: decoded Padloc registration shape after identity patch.
- `zackattacktucker/google-passkey-state.json`: old Zack passkey page inventory.
- `zackattacktucker/google-passkey-login.json`: old Zack fresh-login retest.
- `hassongoblue/google-passkey-state.json`: old Blue passkey page inventory.
- `hassongoblue/google-passkey-login.json`: old Blue fresh-login retest.
- `zackattacktucker-patched/google-passkey-enroll.json`: patched Zack enrollment and Google label.
- `zackattacktucker-patched/google-passkey-login.json`: patched Zack fresh-login result.
- `webauthn-io-proof.json`: public WebAuthn.io external-RP proof through the Padloc extension hook.
- `webauthn-io-proof-rerun-2026-06-30.json`: repeat WebAuthn.io proof after helper hardening.

Screenshots in this folder were redacted in-page before capture.
