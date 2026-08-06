---
type: package guide
title: Localization package
description: Runtime translation loading, extraction, wordlists, package consumers, and translation-drift validation.
tags: [localization, locale, build]
---
# Localization Package

`packages/locale` publishes `@padloc/locale`. `src/translate.ts` supplies runtime translation lookup/loading; `extract.ts` supports extraction; `countries.ts` and `wordlists.ts` provide shared localized data consumed by core and UI packages. `@padloc/core` and `@padloc/app` depend on it, while Worker composition aliases its source for bundling.

Translation extraction is a generated/build surface, not a casual source edit. Run `npm run locale:extract` when translation keys change and inspect the generated artifacts before committing. Forgejo `run-tests.yml` checks extraction consistency and rejects drift. Keep locale identifiers and wordlist data stable because core crypto/password flows may consume them. Use `npm run test:changed -- --files <csv>` plus the locale extraction check for focused changes.
