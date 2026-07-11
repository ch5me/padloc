const { once } = require("events");
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const net = require("net");
const { createRpServer } = require("./rp-server.cjs");

if (process.env.PADLOC_NATIVE_SYSTEM_E2E !== "1") {
    console.log("native-system-e2e skipped: set PADLOC_NATIVE_SYSTEM_E2E=1 on a signed macOS runner");
    process.exit(0);
}

const APP = "/Applications/CH5 Auth Passkeys.app";
const PROVIDER_ID = "me.ch5.auth.dev.passkeys.provider";
const TIMEOUT_MS = Math.max(Number(process.env.PADLOC_NATIVE_SYSTEM_TIMEOUT_MS || 900_000), 300_000);

function requireSuccess(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} prerequisite failed`);
    return result.stdout;
}

async function pollStatus(origin, predicate, label) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${origin}/status`, { cache: "no-store" });
            const status = await response.json();
            if (predicate(status)) return status;
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`${label} timed out while waiting for protected system-sheet approval`);
}

function openSafari(url) {
    requireSuccess("/usr/bin/open", ["-a", "Safari", url]);
}

function providerEvidence(since) {
    return requireSuccess("/usr/bin/log", [
        "show", "--start", since, "--style", "compact", "--info", "--debug",
        "--predicate", 'subsystem == "me.ch5.auth.dev.passkeys.provider"',
    ]);
}

function requireProviderEvidence(since, fingerprint, registrationCount, assertionCount) {
    const evidence = providerEvidence(since);
    const registrations = (evidence.match(/registration completion result=accepted/g) || []).length;
    const assertions = (evidence.match(/assertion verification result=verified/g) || []).length;
    const registrationFingerprints = (evidence.match(/registration credential fingerprint=[0-9a-f]{16}/g) || []);
    const assertionFingerprints = (evidence.match(/assertion credential fingerprint=[0-9a-f]{16}/g) || []);
    const registrationMatches = registrationFingerprints.filter((entry) => entry.endsWith(fingerprint)).length;
    const assertionMatches = assertionFingerprints.filter((entry) => entry.endsWith(fingerprint)).length;
    if (
        registrations < registrationCount || assertions < assertionCount ||
        registrationMatches < registrationCount || assertionMatches < assertionCount
    ) {
        throw new Error("RP result was not bound to the expected CH5 provider callbacks");
    }
}

async function terminateForRestart() {
    for (const [command, args] of [
        ["/usr/bin/pkill", ["-x", "Safari"]],
        ["/usr/bin/pkill", ["-f", PROVIDER_ID]],
    ]) {
        const result = spawnSync(command, args, { stdio: "ignore" });
        if (result.status !== 0 && result.status !== 1) throw new Error("restart process termination failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
}

async function chooseOwnedPort() {
    const requested = process.env.PADLOC_RP_PORT ? Number(process.env.PADLOC_RP_PORT) : 4174;
    for (let port = requested; port < requested + 10; port += 1) {
        const available = await new Promise((resolve) => {
            const probe = net.createServer();
            probe.once("error", () => resolve(false));
            probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
        });
        if (available) return port;
    }
    throw new Error("no owned local RP port is available");
}

async function main() {
    if (process.platform !== "darwin") throw new Error("native-system-e2e requires macOS");
    if (!existsSync(APP)) throw new Error("signed CH5 host app is not installed");
    requireSuccess("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP]);
    const providers = requireSuccess("/usr/bin/pluginkit", ["-mAvvv"]);
    if (providers.split("\n").filter((line) => line.includes(PROVIDER_ID)).length !== 1) {
        throw new Error("expected exactly one installed CH5 credential provider");
    }

    const port = await chooseOwnedPort();
    const origin = `http://localhost:${port}`;
    const instance = createRpServer({ port, origin });
    let closed = false;
    const closeServer = async () => {
        if (closed) return;
        closed = true;
        instance.server.close();
        await once(instance.server, "close");
    };
    process.once("SIGINT", () => { void closeServer().finally(() => process.exit(130)); });
    process.once("SIGTERM", () => { void closeServer().finally(() => process.exit(143)); });
    instance.server.listen(port, instance.host);
    await once(instance.server, "listening");
    console.log("native-system-e2e ready; approve only the protected CH5 system sheets when prompted");
    const evidenceStart = requireSuccess("/bin/date", ["-v-1S", "+%Y-%m-%d %H:%M:%S"]).trim();

    try {
        openSafari(`${origin}/?native-system=register`);
        const registration = await pollStatus(origin, (status) => status.registrationVerified, "registration");
        requireProviderEvidence(evidenceStart, registration.credentialFingerprint, 1, 0);
        await pollStatus(origin, (status) => status.assertionCount >= 1, "first assertion");
        requireProviderEvidence(evidenceStart, registration.credentialFingerprint, 1, 1);

        await terminateForRestart();
        openSafari(`${origin}/?native-system=assert`);
        await pollStatus(origin, (status) => status.assertionCount >= 2, "restart assertion");
        requireProviderEvidence(evidenceStart, registration.credentialFingerprint, 1, 2);
        console.log("native-system-e2e passed: registration, assertion, and restart assertion verified");
    } finally {
        await closeServer();
    }
}

main().catch((error) => {
    console.error(`native-system-e2e failed: ${error.message}`);
    process.exitCode = 1;
});
