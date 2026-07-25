/**
 * Multi-org isolation E2E test — runs inside the Worker via wrangler dev.
 *
 * G010 of magic-browser-multitenant-cloud-ralplan.md ("org-aware provisioning") needs org
 * isolation to actually hold, not just be modeled by the crypto. This proves it at the RPC layer
 * against raw responses, not the rendered UI — per the goal's own guard clause: "isolation holds
 * in the UI but the RPC returns other tenants' ciphertext blobs" would be a real, if low-severity
 * (E2E-encrypted), metadata leak that a UI-only check would miss.
 *
 * Adapted directly from vault-crud-e2e.worker.ts's harness (real Client, real SRP auth, real
 * createServer over a LocalSender) rather than reinventing test plumbing.
 */
import { setPlatform, DeviceInfo, StubPlatform } from "@padloc/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { Client } from "@padloc/core/src/client";
import { Account } from "@padloc/core/src/account";
import { Vault } from "@padloc/core/src/vault";
import { Org } from "@padloc/core/src/org";
import { Auth } from "@padloc/core/src/auth";
import { Client as SRPClient } from "@padloc/core/src/srp";
import {
    Sender,
    Request as TransportRequest,
    RequestProgress,
    Response as CoreResponse,
} from "@padloc/core/src/transport";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { uuid } from "@padloc/core/src/util";
import { createServer } from "../src/server-factory";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@padloc/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@padloc/core/src/api";
import { marshal, unmarshal } from "@padloc/core/src/encoding";
import { AccountLockDO } from "../src/locks/account-lock";

export { AccountLockDO };

class LocalSender implements Sender {
    device: DeviceInfo;

    constructor(device: DeviceInfo) {
        this.device = device;
    }

    async send(req: TransportRequest, _progress?: RequestProgress): Promise<PlResponse> {
        const raw = req.toRaw();
        const json = marshal(raw);
        const serverReq = new TransportRequest().fromRaw(unmarshal(json));
        serverReq.device = this.device;
        const serverRes = await createServer(testEnv).handle(serverReq);
        const resRaw = serverRes.toRaw();
        const resJson = marshal(resRaw);
        return new CoreResponse().fromRaw(unmarshal(resJson));
    }
}

async function createClient(device?: DeviceInfo): Promise<Client> {
    const dev = device || new DeviceInfo({ platform: "test" });
    return new Client({ session: null, account: null, device: dev }, new LocalSender(dev));
}

async function createAccountAndLogin(
    email: string,
    password: string
): Promise<{ accountId: string; mainVaultId: string; client: Client }> {
    const client = await createClient();

    const account = new Account();
    account.email = email;
    account.name = email.split("@")[0];
    account.keyParams.iterations = 1000;
    await account.initialize(password);

    const auth = new Auth(email);
    auth.keyParams = account.keyParams;
    const authKey = await auth.getAuthKey(password);
    const srpInit = new SRPClient();
    await srpInit.initialize(authKey);
    auth.verifier = srpInit.v!;

    const params = new CreateAccountParams({ account, auth, authToken: "" });
    const created = await client.createAccount(params);

    const startRes = await client.startCreateSession(new StartCreateSessionParams({ email }));

    const loginAuth = new Auth(email);
    loginAuth.keyParams = startRes.keyParams;
    const loginAuthKey = await loginAuth.getAuthKey(password);
    const loginSrp = new SRPClient();
    await loginSrp.initialize(loginAuthKey);
    await loginSrp.setB(startRes.B);

    const session = await client.completeCreateSession(
        new CompleteCreateSessionParams({
            accountId: startRes.accountId,
            srpId: startRes.srpId,
            A: loginSrp.A!,
            M: loginSrp.M1!,
            addTrustedDevice: true,
        })
    );

    session.key = loginSrp.K!;
    client.state.session = session;

    return { accountId: created.id, mainVaultId: created.mainVault.id, client };
}

async function createOrgWithSharedVault(
    client: Client,
    email: string,
    password: string,
    orgName: string
): Promise<{ orgId: string; sharedVaultId: string }> {
    const org = new Org();
    org.name = orgName;
    const createdOrg = await client.createOrg(org);

    let hydratedOrg = await client.getOrg(createdOrg.id);
    if (!hydratedOrg.publicKey) {
        const ownerAccount = await client.getAccount();
        await ownerAccount.unlock(password);
        await hydratedOrg.initialize(ownerAccount);
        hydratedOrg = await client.updateOrg(hydratedOrg);
    }

    const sharedVault = new Vault();
    sharedVault.name = `${orgName} Shared Vault`;
    sharedVault.org = { id: hydratedOrg.id, name: hydratedOrg.name, revision: hydratedOrg.revision };
    const createdSharedVault = await client.createVault(sharedVault);

    hydratedOrg = await client.getOrg(hydratedOrg.id);
    const ownerMember = hydratedOrg.getMember({ email });
    if (!ownerMember) throw new Error("owner missing from newly created org");
    ownerMember.vaults.push({ id: createdSharedVault.id, readonly: false });
    await client.updateOrg(hydratedOrg);

    return { orgId: hydratedOrg.id, sharedVaultId: createdSharedVault.id };
}

let testEnv: any;

interface TestResult {
    name: string;
    ok: boolean;
    detail: string;
}

async function runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    async function test(name: string, fn: () => Promise<void>) {
        try {
            await fn();
            results.push({ name, ok: true, detail: "PASS" });
        } catch (err: unknown) {
            results.push({ name, ok: false, detail: `FAIL: ${(err as Error).message || String(err)}` });
        }
    }

    const passwordA = "OrgATestPassword123!";
    const passwordB = "OrgBTestPassword456!";
    const emailA = `org-a-owner-${await uuid()}@test.padloc.app`;
    const emailB = `org-b-owner-${await uuid()}@test.padloc.app`;

    const { client: clientA } = await createAccountAndLogin(emailA, passwordA);
    const { orgId: orgAId, sharedVaultId: vaultAId } = await createOrgWithSharedVault(
        clientA,
        emailA,
        passwordA,
        "Org A"
    );

    const { client: clientB } = await createAccountAndLogin(emailB, passwordB);
    const { orgId: orgBId } = await createOrgWithSharedVault(clientB, emailB, passwordB, "Org B");

    await test("Org B cannot read Org A's org record", async () => {
        let denied = false;
        try {
            const orgAAsSeenByB = await clientB.getOrg(orgAId);
            // If the RPC does not deny outright, the returned record must not leak Org A's
            // membership or key material to a non-member — check the raw response, not a
            // rendered view, per the goal's own "assert on raw RPC responses" guard.
            if (orgAAsSeenByB.members.length === 0 && !orgAAsSeenByB.publicKey) denied = true;
        } catch (err: unknown) {
            if (err instanceof Err && (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.INSUFFICIENT_PERMISSIONS)) {
                denied = true;
            }
        }
        if (!denied) throw new Error("Org B's client obtained Org A's org record with members/key material intact");
    });

    await test("Org B cannot read Org A's shared vault", async () => {
        let denied = false;
        try {
            await clientB.getVault(vaultAId);
        } catch (err: unknown) {
            if (err instanceof Err && (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.INSUFFICIENT_PERMISSIONS)) {
                denied = true;
            }
        }
        if (!denied) throw new Error("Org B's client read Org A's shared vault");
    });

    await test("Org B cannot write Org A's shared vault", async () => {
        let denied = false;
        try {
            const forged = new Vault();
            forged.id = vaultAId;
            forged.name = "Hijacked";
            await clientB.updateVault(forged);
        } catch (err: unknown) {
            if (err instanceof Err && (err.code === ErrorCode.NOT_FOUND || err.code === ErrorCode.INSUFFICIENT_PERMISSIONS)) {
                denied = true;
            }
        }
        if (!denied) throw new Error("Org B's client updated Org A's shared vault");
    });

    await test("Org A's own account listing does not include Org B", async () => {
        const accountA = await clientA.getAccount();
        const orgIds = accountA.orgs.map((o: { id: string }) => o.id);
        if (orgIds.includes(orgBId)) throw new Error("Org A's account.orgs leaked Org B's org id");
        if (!orgIds.includes(orgAId)) throw new Error("Org A's account.orgs is missing its own org id");
    });

    return results;
}

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/multi-org-isolation-tests") {
            try {
                const platform = new StubPlatform();
                platform.crypto = new WorkerCryptoProvider();
                setPlatform(platform);

                const results = await runTests();
                const passed = results.filter((r) => r.ok).length;
                const failed = results.filter((r) => !r.ok).length;
                const body = JSON.stringify(
                    { ok: failed === 0, passed, failed, total: results.length, results },
                    null,
                    2
                );
                return new Response(body, {
                    status: failed === 0 ? 200 : 400,
                    headers: { "Content-Type": "application/json" },
                });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return new Response(JSON.stringify({ ok: false, error: msg }), {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                });
            }
        }

        const config = new WorkerReceiverConfig();
        config.allowOrigin = env.ALLOW_ORIGIN || "*";
        const receiver = new WorkerReceiver(config);

        try {
            return await receiver.handleFetch(
                request,
                async (req: PlRequest): Promise<PlResponse> => {
                    const server = createServer(env);
                    return server.handle(req);
                },
                env,
                ctx
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "server_error";
            return new Response(JSON.stringify({ error: { code: "server_error", message: msg } }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            });
        }
    },
};
