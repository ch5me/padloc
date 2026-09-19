#!/bin/sh
# Native-messaging host entry point. Chrome execs this by the path recorded in
# dance.elf.vault.json — it must stay a plain, fast-starting shell wrapper, not the
# interpreter directly, so the install path can change without touching the manifest.
exec /usr/bin/node /opt/magic-browser/elf-vault-native-host/elf-vault-autofill-host.mjs
