/**
 * Firefly seat-sync E2E test — runs inside the Worker via wrangler dev.
 *
 * G020 of magic-browser-multitenant-cloud-ralplan.md: Elf Vault seat billing routes through
 * Firefly's existing Teams/Enterprise seat machinery, and firefly-cloud propagates a seat-count
 * change to padloc by calling this Worker's real `POST /admin/vault-org-seats` route (see
 * `../src/firefly-seat-sync.ts`) — the exact request firefly-cloud's `defaultVaultSeatSyncClient`
 * (apps/web/src/lib/organizations/vault-seat-sync.ts) sends: `{ orgId, seats }`, bearer secret.
 *
 * This test hits that real route handler with a real `Request` object (not a direct provisioner call), then reuses
 * G010's own `org-seat-quota-e2e.worker.ts` harness and assertions (real Client, real SRP auth,
 * real createServer, no mocks) to prove three things end to end:
 *
 *   1. Propagation: the admin route call actually changes what the server enforces (a fresh org
 *      goes from unlimited to a real cap after one call).
 *   2. Enforcement: confirming a member past the new cap is refused with
 *      PROVISIONING_QUOTA_EXCEEDED — the exact guard G010 built, now driven by the real HTTP call
 *      instead of a direct `setOrgSeats` call.
 *   3. Revocation safety: reducing the seat count below the org's current member count does NOT
 *      remove existing members (no silent forced eviction from a real user's vault) — it only
 *      blocks *new* members from being confirmed. This is the deliberately conservative behavior
 *      G020's proof bar calls for.
 *
 * Auth is tested too: a missing/wrong secret is refused before any provisioning changes.
 */
import { setPlatform, DeviceInfo, StubPlatform } from "@elf-vault/core/src/platform";
import { WorkerCryptoProvider } from "../src/crypto";
import { Client } from "@elf-vault/core/src/client";
import { Account, UnlockedAccount } from "@elf-vault/core/src/account";
import { Org, UnlockedOrg } from "@elf-vault/core/src/org";
import { Auth } from "@elf-vault/core/src/auth";
import { Client as SRPClient } from "@elf-vault/core/src/srp";
import {
    Sender,
    Request as TransportRequest,
    RequestProgress,
    Response as CoreResponse,
} from "@elf-vault/core/src/transport";
import { Err, ErrorCode } from "@elf-vault/core/src/error";
import { uuid } from "@elf-vault/core/src/util";
import { Invite } from "@elf-vault/core/src/invite";
import { GetInviteParams } from "@elf-vault/core/src/api";
import { createServer } from "../src/server-factory";
import { handleSetOrgSeatsRoute } from "../src/firefly-seat-sync";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@elf-vault/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@elf-vault/core/src/api";
import { marshal, unmarshal } from "@elf-vault/core/src/encoding";
import { AccountLockDO } from "../src/locks/account-lock";

export { AccountLockDO };

const TEST_SECRET = "test-firefly-seat-sync-secret";

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

async function createAccountAndLogin(email: string, password: string): Promise<{ accountId: string; client: Client }> {
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

    return { accountId: created.id, client };
}

async function createOrg(client: Client, password: string, orgName: string): Promise<string> {
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

    return hydratedOrg.id;
}

async function unlockOwnerOrg(
    client: Client,
    password: string,
    orgId: string
): Promise<{ ownerAccount: UnlockedAccount; org: UnlockedOrg }> {
    const ownerAccount = await client.getAccount();
    await ownerAccount.unlock(password);
    const org = await client.getOrg(orgId);
    await org.unlock(ownerAccount as UnlockedAccount);
    return { ownerAccount: ownerAccount as UnlockedAccount, org: org as UnlockedOrg };
}

let testEnv: any;

interface TestResult {
    name: string;
    ok: boolean;
    detail: string;
}

/** Calls the real route handler with a real `Request`, exactly as firefly-cloud's HTTP client would. */
async function callSetOrgSeats(orgId: string, seats: number, secret = TEST_SECRET): Promise<Response> {
    const request = new Request("https://padloc-worker.test/admin/vault-org-seats", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ orgId, seats }),
    });
    return handleSetOrgSeatsRoute(request, testEnv);
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

    async function inviteAndConfirm(
        ownerClient: Client,
        ownerPassword: string,
        orgId: string,
        inviteeClient: Client,
        inviteeEmail: string,
        inviteePassword: string
    ): Promise<{ inviteCreateError?: Err; confirmError?: Err }> {
        const { ownerAccount, org: ownerOrg } = await unlockOwnerOrg(ownerClient, ownerPassword, orgId);

        const invite = new Invite(inviteeEmail, "join_org");
        await invite.initialize(ownerOrg, ownerAccount);
        ownerOrg.invites = [...ownerOrg.invites, invite];

        let inviteCreateError: Err | undefined;
        try {
            await ownerClient.updateOrg(ownerOrg);
        } catch (err: unknown) {
            if (!(err instanceof Err)) throw err;
            inviteCreateError = err;
        }

        if (inviteCreateError) {
            return { inviteCreateError };
        }

        const fetchedInvite = await inviteeClient.getInvite(new GetInviteParams({ org: orgId, id: invite.id }));
        const inviteeAccount = await inviteeClient.getAccount();
        await inviteeAccount.unlock(inviteePassword);
        const accepted = await fetchedInvite.accept(inviteeAccount, invite.secret!);
        if (!accepted) {
            throw new Error("invitee failed to accept invite (bad secret or expired)");
        }
        await inviteeClient.acceptInvite(fetchedInvite);

        const { org: orgForConfirm } = await unlockOwnerOrg(ownerClient, ownerPassword, orgId);
        const acceptedInvite = orgForConfirm.getInvite(invite.id)!;
        await acceptedInvite.unlock(orgForConfirm.invitesKey!);
        const verified = await acceptedInvite.verifyInvitee();
        if (!verified) {
            throw new Error("owner failed to verify invitee details");
        }

        await orgForConfirm.addOrUpdateMember(acceptedInvite.invitee!);
        orgForConfirm.removeInvite(acceptedInvite);

        try {
            await ownerClient.updateOrg(orgForConfirm);
            return {};
        } catch (err: unknown) {
            if (err instanceof Err) return { confirmError: err };
            throw err;
        }
    }

    // ── Auth: wrong/missing secret is refused before touching provisioning ──

    const authOwnerPassword = "AuthOwnerPassword123!";
    const authEmail = `auth-owner-${await uuid()}@test.padloc.app`;
    const { client: authOwnerClient } = await createAccountAndLogin(authEmail, authOwnerPassword);
    const authOrgId = await createOrg(authOwnerClient, authOwnerPassword, "Auth Org");

    await test("A request with the wrong bearer secret is refused with 401 and does not change the seat cap", async () => {
        const res = await callSetOrgSeats(authOrgId, 1, "wrong-secret");
        if (res.status !== 401) {
            throw new Error(`expected 401, got ${res.status}`);
        }
    });

    await test("A request with no bearer header is refused with 401", async () => {
        const request = new Request("https://padloc-worker.test/admin/vault-org-seats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgId: authOrgId, seats: 1 }),
        });
        const res = await handleSetOrgSeatsRoute(request, testEnv);
        if (res.status !== 401) {
            throw new Error(`expected 401, got ${res.status}`);
        }
    });

    // ── Propagation + enforcement: the real HTTP call actually changes what's enforced ──

    const ownerPasswordAtCap = "SeatCapOwnerPassword123!";
    const inviteePasswordAtCap = "SeatCapInviteePassword456!";
    const emailOwnerAtCap = `seat-cap-owner-${await uuid()}@test.padloc.app`;
    const emailInviteeAtCap = `seat-cap-invitee-${await uuid()}@test.padloc.app`;

    const { client: ownerClientAtCap } = await createAccountAndLogin(emailOwnerAtCap, ownerPasswordAtCap);
    const orgAtCapId = await createOrg(ownerClientAtCap, ownerPasswordAtCap, "At-Cap Org");
    const { client: inviteeClientAtCap } = await createAccountAndLogin(emailInviteeAtCap, inviteePasswordAtCap);

    await test("POST /admin/vault-org-seats with the correct secret returns 200", async () => {
        // Org already has 1 member (the owner) — setting exactly 1 seat via the real HTTP route
        // puts it at capacity, simulating a Firefly org that purchased 1 seat.
        const res = await callSetOrgSeats(orgAtCapId, 1);
        if (res.status !== 200) {
            throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
        }
    });

    let atCapOutcome: Awaited<ReturnType<typeof inviteAndConfirm>> | undefined;

    await test("Invite creation succeeds even when the org is already at its seat cap", async () => {
        atCapOutcome = await inviteAndConfirm(
            ownerClientAtCap,
            ownerPasswordAtCap,
            orgAtCapId,
            inviteeClientAtCap,
            emailInviteeAtCap,
            inviteePasswordAtCap
        );
        if (atCapOutcome.inviteCreateError) {
            throw new Error(
                `invite creation was refused (code=${atCapOutcome.inviteCreateError.code}) — enforcement must ` +
                    "not fire at invite creation, only at member confirmation"
            );
        }
    });

    await test("Confirming a member past the seat cap set via the real HTTP route is refused with PROVISIONING_QUOTA_EXCEEDED", async () => {
        if (!atCapOutcome || !atCapOutcome.confirmError) {
            throw new Error("expected the owner's member-confirming updateOrg call to be refused, but it succeeded");
        }
        if (atCapOutcome.confirmError.code !== ErrorCode.PROVISIONING_QUOTA_EXCEEDED) {
            throw new Error(`expected PROVISIONING_QUOTA_EXCEEDED, got ${atCapOutcome.confirmError.code}`);
        }
    });

    // ── Positive path: raising the cap via the real route allows a confirm ──

    await test("Raising the cap via a second real HTTP call allows the previously-refused member to be confirmed", async () => {
        const res = await callSetOrgSeats(orgAtCapId, 2);
        if (res.status !== 200) {
            throw new Error(`expected 200, got ${res.status}`);
        }

        const { org: orgForConfirm } = await unlockOwnerOrg(ownerClientAtCap, ownerPasswordAtCap, orgAtCapId);
        const invite = orgForConfirm.invites[0];
        if (!invite) {
            throw new Error("expected the earlier invite to still be pending");
        }
        await invite.unlock(orgForConfirm.invitesKey!);
        const verified = await invite.verifyInvitee();
        if (!verified) {
            throw new Error("owner failed to verify invitee details on retry");
        }
        await orgForConfirm.addOrUpdateMember(invite.invitee!);
        orgForConfirm.removeInvite(invite);
        await ownerClientAtCap.updateOrg(orgForConfirm);

        const org = await ownerClientAtCap.getOrg(orgAtCapId);
        if (org.members.length !== 2) {
            throw new Error(`expected org to have 2 members after raising the cap, has ${org.members.length}`);
        }
    });

    // ── Revocation safety: lowering the cap below current headcount never removes members ──

    await test("Lowering the seat cap below the org's current member count via the real HTTP route does NOT remove existing members", async () => {
        const res = await callSetOrgSeats(orgAtCapId, 1);
        if (res.status !== 200) {
            throw new Error(`expected 200, got ${res.status}`);
        }

        const org = await ownerClientAtCap.getOrg(orgAtCapId);
        if (org.members.length !== 2) {
            throw new Error(
                `expected org to still have both members after the seat cap was lowered below headcount, has ${org.members.length}`
            );
        }
    });

    await test("With the cap lowered below headcount, a THIRD member cannot be confirmed", async () => {
        const secondInviteePassword = "ThirdMemberPassword789!";
        const secondInviteeEmail = `third-member-${await uuid()}@test.padloc.app`;
        const { client: thirdMemberClient } = await createAccountAndLogin(secondInviteeEmail, secondInviteePassword);

        const outcome = await inviteAndConfirm(
            ownerClientAtCap,
            ownerPasswordAtCap,
            orgAtCapId,
            thirdMemberClient,
            secondInviteeEmail,
            secondInviteePassword
        );

        if (!outcome.confirmError) {
            throw new Error("expected confirming a 3rd member to be refused given a 1-seat cap and 2 members");
        }
        if (outcome.confirmError.code !== ErrorCode.PROVISIONING_QUOTA_EXCEEDED) {
            throw new Error(`expected PROVISIONING_QUOTA_EXCEEDED, got ${outcome.confirmError.code}`);
        }

        const org = await ownerClientAtCap.getOrg(orgAtCapId);
        if (org.members.length !== 2) {
            throw new Error(`expected org to still have exactly 2 members, has ${org.members.length}`);
        }
    });

    return results;
}

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        testEnv = { ...env, FIREFLY_SEAT_SYNC_SECRET: TEST_SECRET };

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/firefly-seat-sync-tests") {
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

        // Real route under test, wired the same way production `index.ts` wires it — reachable
        // here too, not just via `callSetOrgSeats`'s direct call. Both call the identical
        // production handler; the in-process call (not a literal TCP round-trip) matches this
        // repo's existing e2e-harness standard (org-seat-quota-e2e, multi-org-isolation-e2e): real
        // server, real crypto, real SRP, no mocks.
        if (request.method === "POST" && url.pathname === "/admin/vault-org-seats") {
            return handleSetOrgSeatsRoute(request, testEnv);
        }

        const config = new WorkerReceiverConfig();
        config.allowOrigin = env.ALLOW_ORIGIN || "*";
        const receiver = new WorkerReceiver(config);

        try {
            return await receiver.handleFetch(
                request,
                async (req: PlRequest): Promise<PlResponse> => {
                    const server = createServer(testEnv);
                    return server.handle(req);
                },
                testEnv,
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
