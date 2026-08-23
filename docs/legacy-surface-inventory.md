# Legacy surface reachability inventory

This inventory records repository reachability at source commit
`10f8e65bf56f095479ba46bc4d1afc17dafd7b93`. “Reachable” means that a checked-in
script, service declaration, workflow, image, or release contract can still
consume the surface. It does **not** by itself mean that CH5 ships or operates
the surface.

The shipped product declaration names the PWA, Worker API, and iPhone app.
Accordingly, none of the four packages below is classified as a current shipped
surface merely because source and build machinery remain.

## Summary

| Surface             | Classification                                                                    | Repository reachability                                                                                                                                                                                  | Distribution/runtime evidence                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/admin`    | **Retired / orphaned source**                                                     | Included by Lerna's broad `packages/*` discovery and dependency installation, but has no package scripts, root scripts, service declaration, workflow, Docker copy, or imports from another package.     | No checked-in deployment or publication consumer was found.                                                                                                                                                                                                              |
| `packages/server`   | **Replaced production runtime; legacy build/publish path remains reachable**      | `Dockerfile-server` still assembles it (though its default start command is stale); branch regression builds that image; the manual Docker Hub workflow can publish `padloc/server:latest`.              | The CH5 production API is the Worker. Root `server:start-dry` now aliases the Worker dry-run rather than starting this Node server. Whether the manual Docker Hub workflow is still invoked, and whether its tag has consumers, is **UNKNOWN** from repository evidence. |
| `packages/electron` | **Build-verified legacy desktop candidate; not a shipped/download surface**       | Root build scripts target it; branch regression builds an unsigned Linux directory; a manual workflow builds and uploads Linux/macOS artifacts.                                                          | The support matrix records Linux/macOS desktop as verified builds without distribution and does not identify Electron versus Tauri. No Electron artifact enters the public-release manifest pipeline. Actual use of manual workflow artifacts is **UNKNOWN**.            |
| `packages/tauri`    | **Active local/build-verified desktop candidate; not a shipped/download surface** | `pitchfork.toml` and `ch5-svc` expose a local `tauri` daemon; root dev/build/update scripts target it; branch regression runs its Rust check; a manual matrix workflow builds and uploads debug bundles. | The support matrix records Linux/macOS desktop as verified builds without distribution and Windows as unsupported. No Tauri artifact enters the public-release manifest pipeline. Actual use of manual workflow artifacts is **UNKNOWN**.                                |

## Evidence and removal gates

### Admin portal (`packages/admin`)

**Observed evidence**

-   The manifest describes a private “Padloc Admin Portal”, but defines no
    `scripts`.
-   Its webpack configuration can produce a standalone portal configured by
    `PL_ADMIN_URL`, `PL_ADMIN_URL_PATH`, and `PL_SERVER_URL`.
-   The source calls privileged account, organization, change-log, and
    request-log APIs. Those API concepts cannot be deleted solely because this
    UI is orphaned; other administrative or audit consumers must be inventoried
    separately.
-   Repository-wide package-name/path searches found no consumer outside the
    package. The root has no admin command, `pitchfork.toml` has no admin
    daemon, and Forgejo workflows do not build or publish it.

**Deletion prerequisites**

1. Confirm with operators that there is no externally maintained build/deploy of
   this source and no required admin-portal URL; repository evidence cannot
   prove absence of off-repository consumers.
2. Decide independently whether the privileged API operations and audit data
   remain operationally required. Removing this UI is not evidence that those
   contracts are unused.
3. Remove the package and its lockfile, then regenerate the root dependency
   graph in a dedicated dependency-change lane and prove clean install,
   formatting, and changed-package checks.
4. Update package listings and upstream-compatibility documentation in the same
   retirement change.

### Node server (`packages/server`)

**Observed evidence**

-   The fork strategy explicitly says the Node.js server was replaced by the
    Cloudflare Worker and is preserved but unused by the CH5 runtime.
-   `Dockerfile-server` still copies `packages/server`, shared core/locale code,
    and assets. Its default command attempts `npm run start`, but the server
    manifest defines no scripts, so the checked-in image has no evidenced
    working default launch command.
-   Branch regression builds this Dockerfile without pushing. The manual
    `update-dockerhub.yml` workflow logs into Docker Hub and is capable of
    pushing `padloc/server:latest`.
-   The generic test workflow caches server dependencies, but its “zero-config
    server” command is `npm run server:start-dry`; the root maps that command to
    `npm run worker:deploy:dry-run`. It is Worker proof, not Node-server
    reachability.
-   `scripts/inventory-api.ts` reads the legacy HTTP transport and the shared
    core server controller to generate contract documentation. That is a
    documentation consumer even though it is not a shipped runtime.

**Deletion prerequisites**

1. Establish that the Docker Hub image/tag has no deployments or downstream
   pullers, then retire or redirect the manual publication workflow before
   deleting its build context. This cannot be concluded from Git alone.
2. Decide whether branch CI should retain any legacy-container compatibility
   proof; remove both Docker build consumers if the answer is no.
3. Move `scripts/inventory-api.ts` to Worker-owned sources or retire the
   generated contract dependency on `packages/server/src/transport/http.ts`.
4. Audit Worker/core boundaries before removing server dependencies: the Worker
   intentionally reuses shared `packages/core` server/controller logic, which is
   not the same thing as using the Node package.
5. Remove stale documentation, cache entries, Dockerfile, package/lockfile, and
   dependency graph together; prove Worker API parity and migration/data
   compatibility first.

### Electron desktop (`packages/electron`)

**Observed evidence**

-   Root commands expose `electron:start`, `electron:build`, and
    `electron:build:flatpak`.
-   The package manifest has build scripts but no `start` script, so the root
    `electron:start` command does not currently resolve to a package command.
-   Branch regression executes `build:ci` to produce an unsigned Linux unpacked
    app. The dispatch-only `build-electron.yml` can build and upload AppImage,
    deb, snap, flatpak, unpacked Linux, and unsigned or signed macOS DMG
    artifacts.
-   Electron loads a configured PWA URL rather than embedding the PWA build; its
    packaging configuration still contains signing/notarization hooks.
-   `config/platform-support.json` says Linux and macOS have verified desktop
    builds but no durable staging distribution proof. Public release
    documentation says the only initial durable staging download is the unsigned
    extension ZIP.

**Deletion prerequisites**

1. Choose the surviving desktop strategy explicitly. Do not delete Electron
   while “desktop verified build” remains implementation-agnostic in the support
   matrix unless Tauri is designated and proven as its replacement.
2. Confirm no operator depends on dispatch-workflow artifacts, signing secrets,
   updater metadata, protocol handling, or Electron-specific packages.
3. Remove the root scripts, branch-regression step, manual workflow, package
   cache entries, package/lockfile, and desktop documentation as one coherent
   retirement.
4. Update platform support to name the surviving implementation and rerun the
   owned Linux/macOS desktop proof. If no implementation survives, downgrade the
   corresponding support claims.

### Tauri desktop (`packages/tauri`)

**Observed evidence**

-   This is the only legacy package declared as a local service:
    `ch5-svc up tauri` reaches the `pitchfork.toml` daemon, which runs the Tauri
    dev command and depends on the Worker API.
-   Root commands expose dev, dependency update, release build, and debug build.
    Branch regression generates icons, builds the web layer, and runs
    `cargo check --locked`.
-   Dispatch-only `build-tauri.yml` targets Linux, Intel/Apple Silicon macOS,
    and Windows, then uploads debug bundle artifacts. Its existence does not
    override the reviewed support matrix: Windows remains unsupported, and
    Linux/macOS have build proof but no distribution.
-   Tauri compiles its own app UI against shared app/core/locale packages and
    the Worker URL. It is therefore more than a thin reference to a hosted PWA,
    but it is not in the public-release publication pipeline.

**Deletion prerequisites**

1. Decide whether Tauri is the intended successor to Electron. If so, retain it
   and make platform/release ownership explicit instead of calling it legacy.
2. If retiring it, first confirm that no developer relies on the `ch5-svc`
   desktop daemon or dispatch artifacts and that no updater/signing keys or
   installed clients remain off repository.
3. Remove its pitchfork daemon, root scripts, branch-regression check, manual
   workflow, package cache entries, Rust/Node manifests and locks, and package
   source together.
4. Reclassify Linux/macOS desktop support (and keep Windows unsupported) unless
   Electron supplies equivalent owned proof; validate service configuration
   after removing the daemon.

## Interpretation limits

This is a static reachability trace, not production telemetry. Workflow
definitions prove that a path _can_ run, not that anyone runs it. Conversely,
absence of a checked-in consumer cannot disprove an external deployment,
installed desktop client, Docker puller, or manually retained artifact. Those
questions are deliberately marked **UNKNOWN** and require registry, Forgejo
artifact/run, deployment, updater, and operator evidence before deletion.
