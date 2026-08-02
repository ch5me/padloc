# CH5 Auth — Design

## Identity

CH5 Auth (`pad.ch5.me`) is CH5's encrypted credential, passkey, and
personal-autofill vault — a CH5-maintained fork of Padloc with a
Cloudflare-native backend, web/native clients, and a security-gated bridge to
Magic Browser for agentic autofill. It is a federated member of the
Firefly/ELF product ecosystem but keeps its own hard security boundary: raw
secrets never leave the vault, never hit logs, command arguments,
screenshots, or durable browser proof. The product is in maintenance mode —
security fixes and upstream compatibility, not feature sprawl. Its visuals
should carry that: a locked, sealed, load-bearing feeling. Calm, precise,
vault-grade — not playful, not a generic SaaS dashboard.

## Icon

The mark is a padlock body — the closed shackle-and-body silhouette Padloc
has always used, redrawn as one solid closed shape, not a wireframe outline.
It depicts the single, literal, unambiguous idea of "this is locked and
sealed." It must never become: a generic shield, a fingerprint, an abstract
geometric blob, a key by itself (keys imply "opening," this product is about
staying shut), or a rainbow-striped nested-outline mark like the legacy
Padloc icon it replaces — one shape, one solid fill, no text.

## Palette

- **Primary — `#7B4DFF`** (violet-blue): the existing `--ch5-brand` token
  already live in `assets/theme.css` and used across the shipped PWA chrome.
  Reusing it (not inventing a new default) keeps generated marketing/icon
  assets visually consistent with the actual running app.
- **Accent — `#18CFC4`** (teal): the existing `--ch5-accent` token. Cool
  against the violet primary, reads as "secure/verified" rather than
  "alert," and avoids pairing violet with the app's own pink
  (`--ch5-primary` `#FF4AA5`, reserved for in-app highlight/favorite states,
  not brand marks).
- **Neutral — `#1C2550`** (deep navy): the existing `--ch5-foreground` token
  — dark enough to anchor a vault-grade mark without going flat black.

## Anti-goals

- No generic purple-AI-SaaS gradient blob; no `#A855F7`.
- No rainbow nested-outline padlock (the legacy Padloc `assets/app-icon.svg`
  look) — one shape, one solid fill.
- No shield, no fingerprint, no abstract lock-adjacent geometry standing in
  for an actual padlock.
- No key-only mark — this product's story is staying shut, not opening.
- No text, no written characters, no calligraphy, no app-store screenshot
  chrome baked into the icon.
