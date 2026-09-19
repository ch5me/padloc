/**
 * Org seat quota E2E test — runs inside the Worker via wrangler dev.
 *
 * G010 of magic-browser-multitenant-cloud-ralplan.md ("org-aware provisioning") calls out a
 * specific silent half-work to guard against: an org could send unlimited invites at a fixed
 * seat price if the quota is enforced at invite CREATION instead of invite ACCEPTANCE. This test
 * proves the enforcement point is acceptance, against raw RPC responses (real `updateOrg` calls
 * over a real `Client`), not a UI assumption:
 *
 *   1. An org is put on a 1-seat allocation (`OrgAwareProvisioner.setOrgSeats`) while it already
 *      has exactly 1 member (the owner) — i.e. already at capacity.
 *   2. Creating an invite past capacity (an `updateOrg` call that only adds an invite, not a
 *      member) MUST succeed — proving creation is not the enforcement point.
 *   3. The invitee accepting and the owner confirming (the `updateOrg` call that actually grows
 *      `org.members`) MUST be refused with `PROVISIONING_QUOTA_EXCEEDED` — proving acceptance is.
 *   4. A second org on a 2-seat allocation proves the positive path: confirming a member within
 *      the seat cap succeeds, so this isn't a provisioner that just always blocks.
 *
 * Adapted directly from multi-org-isolation-e2e.worker.ts's harness (real Client, real SRP auth,
 * real createServer over a LocalSender, no mocks).
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
import { OrgAwareProvisioner } from "../src/provisioner/org-aware";
import { D1Storage } from "../src/storage/d1";
import { WorkerReceiver, WorkerReceiverConfig } from "../src/transport";
import { Request as PlRequest, Response as PlResponse } from "@elf-vault/core/src/transport";
import { CreateAccountParams, StartCreateSessionParams, CompleteCreateSessionParams } from "@elf-vault/core/src/api";
import { marshal, unmarshal } from "@elf-vault/core/src/encoding";
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
): Promise<{ accountId: string; client: Client }> {
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

/** Unlock the org owner's account and the org itself; returns both unlocked. */
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

    // Direct D1 access to set seat allocations — same storage backend the running server uses,
    // exercised the same way `OrgAwareProvisioner.setOrgSeats` would be called by a future
    // plan-admin caller (G020's Firefly seat-billing wiring is explicitly out of scope for G010).
    const storage = new D1Storage(testEnv.DB);
    const provisioner = new OrgAwareProvisioner(storage);

    async function inviteAndConfirm(
        ownerClient: Client,
        ownerPassword: string,
        orgId: string,
        inviteeClient: Client,
        inviteeEmail: string,
        inviteePassword: string
    ): Promise<{ inviteCreateError?: Err; confirmError?: Err }> {
        // ── Owner creates the invite ──
        const { ownerAccount, org: ownerOrg } = await unlockOwnerOrg(ownerClient, ownerPassword, orgId);

        const invite = new Invite(inviteeEmail, "join_org");
        await invite.initialize(ownerOrg, ownerAccount);
        ownerOrg.invites = [...ownerOrg.invites, invite];

        // This updateOrg call only adds an invite, never touches org.members — must succeed even
        // when the org is already at (or past) its seat cap. Captured explicitly (not just left to
        // propagate) so a regression that moves enforcement to creation fails THIS assertion with
        // its real error code, instead of the test merely erroring out on an unrelated exception.
        let inviteCreateError: Err | undefined;
        try {
            await ownerClient.updateOrg(ownerOrg);
        } catch (err: unknown) {
            if (!(err instanceof Err)) {
                throw err;
            }
            inviteCreateError = err;
        }

        if (inviteCreateError) {
            // Invite creation was refused — nothing to accept/confirm. Report the failure and stop
            // rather than continuing into an accept/confirm flow for an invite that doesn't exist.
            return { inviteCreateError };
        }

        // ── Invitee accepts (out of band: owner hands the invite secret to the invitee) ──
        const fetchedInvite = await inviteeClient.getInvite(new GetInviteParams({ org: orgId, id: invite.id }));
        const inviteeAccount = await inviteeClient.getAccount();
        await inviteeAccount.unlock(inviteePassword);
        const accepted = await fetchedInvite.accept(inviteeAccount, invite.secret!);
        if (!accepted) {
            throw new Error("invitee failed to accept invite (bad secret or expired)");
        }
        await inviteeClient.acceptInvite(fetchedInvite);

        // ── Owner confirms: this is the updateOrg call that actually grows org.members ──
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
            if (err instanceof Err) {
                return { confirmError: err };
            }
            throw err;
        }
    }

    const ownerPasswordAtCap = "SeatCapOwnerPassword123!";
    const inviteePasswordAtCap = "SeatCapInviteePassword456!";
    const emailOwnerAtCap = `seat-cap-owner-${await uuid()}@test.padloc.app`;
    const emailInviteeAtCap = `seat-cap-invitee-${await uuid()}@test.padloc.app`;

    const { client: ownerClientAtCap } = await createAccountAndLogin(emailOwnerAtCap, ownerPasswordAtCap);
    const orgAtCapId = await createOrg(ownerClientAtCap, ownerPasswordAtCap, "At-Cap Org");
    const { client: inviteeClientAtCap } = await createAccountAndLogin(emailInviteeAtCap, inviteePasswordAtCap);

    // Org already has 1 member (the owner) — allocate exactly 1 seat, i.e. already at capacity.
    await provisioner.setOrgSeats(orgAtCapId, 1);

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
        // This is the half of the guard clause that matters: creating an invite must not be
        // blocked by the seat cap, and specifically must not fail with the quota error — if
        // enforcement ever moves to creation, this assertion (not an unrelated downstream
        // failure) is what catches it.
        if (atCapOutcome.inviteCreateError) {
            throw new Error(
                `invite creation was refused (code=${atCapOutcome.inviteCreateError.code}) — enforcement must ` +
                    "not fire at invite creation, only at member confirmation"
            );
        }
    });

    await test("Confirming a member past the seat cap is refused with PROVISIONING_QUOTA_EXCEEDED", async () => {
        if (!atCapOutcome || !atCapOutcome.confirmError) {
            throw new Error(
                "expected the owner's member-confirming updateOrg call to be refused, but it succeeded " +
                    "— an org at its seat cap must not be able to gain a member via invite acceptance"
            );
        }
        if (atCapOutcome.confirmError.code !== ErrorCode.PROVISIONING_QUOTA_EXCEEDED) {
            throw new Error(`expected PROVISIONING_QUOTA_EXCEEDED, got ${atCapOutcome.confirmError.code}`);
        }
    });

    await test("Org member count stays at 1 after the refused confirm", async () => {
        const org = await ownerClientAtCap.getOrg(orgAtCapId);
        if (org.members.length !== 1) {
            throw new Error(`expected org to still have exactly 1 member, has ${org.members.length}`);
        }
    });

    // ── Positive path: an org with headroom can confirm a member normally ──

    const ownerPasswordUnderCap = "UnderCapOwnerPassword123!";
    const inviteePasswordUnderCap = "UnderCapInviteePassword456!";
    const emailOwnerUnderCap = `under-cap-owner-${await uuid()}@test.padloc.app`;
    const emailInviteeUnderCap = `under-cap-invitee-${await uuid()}@test.padloc.app`;

    const { client: ownerClientUnderCap } = await createAccountAndLogin(emailOwnerUnderCap, ownerPasswordUnderCap);
    const orgUnderCapId = await createOrg(ownerClientUnderCap, ownerPasswordUnderCap, "Under-Cap Org");
    const { client: inviteeClientUnderCap } = await createAccountAndLogin(
        emailInviteeUnderCap,
        inviteePasswordUnderCap
    );

    // 2 seats for an org with 1 member — room for exactly one more.
    await provisioner.setOrgSeats(orgUnderCapId, 2);

    await test("Confirming a member within the seat cap succeeds", async () => {
        const outcome = await inviteAndConfirm(
            ownerClientUnderCap,
            ownerPasswordUnderCap,
            orgUnderCapId,
            inviteeClientUnderCap,
            emailInviteeUnderCap,
            inviteePasswordUnderCap
        );
        if (outcome.inviteCreateError) {
            throw new Error(`expected invite creation to succeed, got ${outcome.inviteCreateError.message}`);
        }
        if (outcome.confirmError) {
            throw new Error(`expected confirm to succeed within the seat cap, got ${outcome.confirmError.message}`);
        }
        const org = await ownerClientUnderCap.getOrg(orgUnderCapId);
        if (org.members.length !== 2) {
            throw new Error(`expected org to have 2 members after a within-cap confirm, has ${org.members.length}`);
        }
    });

    return results;
}

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
        testEnv = env;

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/org-seat-quota-tests") {
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
