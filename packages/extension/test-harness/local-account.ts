import { Account } from "@padloc/core/src/account";
import { Auth } from "@padloc/core/src/auth";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { ErrorCode, Err } from "@padloc/core/src/error";
import { DeviceInfo, setPlatform } from "@padloc/core/src/platform";
import { Client as SRPClient } from "@padloc/core/src/srp";
import { MemoryStorage } from "@padloc/core/src/storage";
import { Request, Response } from "@padloc/core/src/transport";
import { WorkerCryptoProvider } from "../../worker/src/crypto";

const TEST_ITERATIONS = 10_000;
let canaryDeviceId = "passkey-canary";

setPlatform({
    crypto: new WorkerCryptoProvider(),
    storage: new MemoryStorage(),
    getDeviceInfo: async () => new DeviceInfo({ platform: "node", runtime: "node", id: canaryDeviceId }),
    supportedAuthTypes: [],
} as any);

async function callApi(workerUrl: string, method: string, params: unknown[]): Promise<any> {
    const request = new Request();
    request.method = method;
    request.params = params;
    request.device = new DeviceInfo({ platform: "node", runtime: "node", id: canaryDeviceId });
    const response = await fetch(workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: marshal(request.toRaw()),
    });
    const text = await response.text();
    if (!response.ok) {
        const parsed = JSON.parse(text);
        throw new Err(parsed.error?.code || ErrorCode.SERVER_ERROR, parsed.error?.message || text);
    }
    const coreResponse = new Response().fromRaw(unmarshal(text));
    if (coreResponse.error) throw new Err(coreResponse.error.code as ErrorCode, coreResponse.error.message);
    return coreResponse.result;
}

/** Create a local-only account with reduced PBKDF2 cost so browser E2E setup stays bounded. */
export async function createLocalPadlocAccount(
    workerUrl: string,
    email: string,
    password: string,
    deviceId: string
): Promise<void> {
    canaryDeviceId = deviceId;
    const account = new Account();
    account.email = email;
    account.name = "Passkey Canary";
    account.keyParams.iterations = TEST_ITERATIONS;
    await account.initialize(password);

    const auth = new Auth(email);
    auth.keyParams = account.keyParams;
    const authKey = await auth.getAuthKey(password);
    const srp = new SRPClient();
    await srp.initialize(authKey);
    auth.verifier = srp.v!;

    await callApi(workerUrl, "createAccount", [
        {
            account: account.toRaw(),
            auth: auth.toRaw(),
            authToken: "",
        },
    ]);
}

if (require.main === module) {
    const [, , workerUrl, email, password, deviceId] = process.argv;
    if (!workerUrl || !email || !password || !deviceId) {
        throw new Error("Expected worker URL, email, password, and trusted device ID");
    }
    void createLocalPadlocAccount(workerUrl, email, password, deviceId).catch((error) => {
        console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        process.exitCode = 1;
    });
}
