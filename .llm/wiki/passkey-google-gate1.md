# Google Passkey Gate 1

## Current Verdict

-   Zack non-Crown Google accepted a Padloc-created credential on 2026-07-08.
-   Google showed the new credential as `Passkey`, with `Created: Just now` and
    `Last used: Not yet used`.
-   Fresh login after clearing only Google session still stopped at password-only
    chooser, and Chris saw Google's `2-Step Verification only security key`
    message.

## Evidence

-   `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-state.json`
-   `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login.json`
-   `.sisyphus/evidence/gate1-noncrown/zack/google-passkey-login-after.png`

## Important Implementation Note

-   Padloc used to set WebAuthn BE and BS flags on every generated passkey.
-   That was not truthful for the current extension-local signer store: the
    private key is durable, but not proven synced/backed up.
-   Until Padloc implements real passkey backup/sync semantics, generated
    authData should be device-bound: UP/UV/AT as applicable, with BE=0 and BS=0.

## Next Experiment

-   Capture a 1Password-created Google passkey on the same Zack account.
-   Diff decoded registration and assertion fields against Padloc:
    AAGUID, attestation fmt/path, attachment, transports, UP/UV/BE/BS/AT flags,
    signCount, credProps, credProtect, userHandle, and discoverable assertion
    behavior.
-   Do not retry Crown until non-Crown first-factor login passes.
