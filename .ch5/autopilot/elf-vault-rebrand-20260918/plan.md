# Elf Vault Rebrand Execution Plan

1. Runtime/domain contract: canonical Elf Vault hosts, old/new CORS, retained old routes, stronger
   runtime checker and negative tests.
2. Brand/assets: canonical name/icon, PWA/app/extension/native/locales, bounded customer-surface
   scanner, origin-safe CSP, native source build proof.
3. Email: rebrand assets, regenerate Worker templates, add source/generated/render checks.
4. Deployment/release: derive hosts from target map, harden direct production preflight, add PWA
   provenance and deployed-surface canary, update release labels while retaining machine IDs.
5. Integration: changed-only tests, production PWA builds, extension preflight, local service proof,
   independent review and adversarial QA.
6. Staging operations: add DNS/routes/Pages domains, deploy exact candidate, prove old/new hosts.
7. Production operations: promote the same staging-proven candidate, prove old/new hosts.
8. Sibling consumers: monitoring, egress allowlists and catalog references switch only after the
   corresponding Elf Vault host is live.
