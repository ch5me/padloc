import { Account, AccountID } from "@elf-vault/core/src/account";
import { OrgInfo } from "@elf-vault/core/src/org";
import { Err, ErrorCode } from "@elf-vault/core/src/error";
import {
    Provisioner,
    Provisioning,
    ProvisioningStatus,
    OrgProvisioning as OrgProv,
    OrgSeatAllocation,
} from "@elf-vault/core/src/provisioning";
import { Session } from "@elf-vault/core/src/session";
import { Storage } from "@elf-vault/core/src/storage";

function debugLog(...args: unknown[]) {
    typeof console !== "undefined" && console.debug("[OrgAwareProvisioner]", ...args);
}

/**
 * Org/seat-aware provisioner (G010 of magic-browser-multitenant-cloud-ralplan.md).
 *
 * Replaces `PersonalProvisioner`. Account-level behavior (unlimited personal vaults/storage, no
 * billing UI) is unchanged from `PersonalProvisioner` — orgs, groups, roles, invites, and the
 * underlying crypto already exist and are not touched here. What's new is the *plan and seat*
 * layer: each org's `OrgProvisioning.quota.members` is populated from a persisted
 * `OrgSeatAllocation` (see packages/core/src/provisioning.ts) instead of being hardcoded to -1
 * (unlimited). An org with no allocation on record stays unlimited — this is a strictly additive
 * capability, not a behavior change for orgs nobody has put on a seat plan.
 *
 * The actual enforcement — refusing to add a member once `members.length > quota.members` — is
 * NOT implemented here. It already lives in `Server.updateOrg` (packages/core/src/server.ts) and
 * fires wherever `org.members` actually grows, which per the client flow
 * (App.confirmInvite/Org.addOrUpdateMember) is invite ACCEPTANCE, not invite creation. This
 * provisioner's job is narrower and easy to state: give that existing check a real, finite number
 * to enforce against for orgs that have one.
 *
 * G020 (a separate, later goal) will wire `setOrgSeats` up to Firefly's Teams/Enterprise seat
 * billing. This provisioner has no knowledge of billing — it only knows how to read and write a
 * seat count.
 */
export class OrgAwareProvisioner implements Provisioner {
    constructor(private storage?: Storage) {}

    async getProvisioning(
        params: { email: string; accountId?: AccountID; account?: AccountID; orgs?: OrgInfo[] },
        _session?: Session
    ): Promise<Provisioning> {
        debugLog("getProvisioning", {
            hasAccountId: Boolean(params.accountId || params.account),
            orgCount: params.orgs?.length ?? 0,
        });

        const provisioning = new Provisioning();

        provisioning.account.status = ProvisioningStatus.Active;
        provisioning.account.statusLabel = "";
        provisioning.account.statusMessage = "";
        provisioning.account.quota.vaults = -1;
        provisioning.account.quota.storage = -1;

        provisioning.account.features.billing.disabled = true;
        provisioning.account.features.billing.hidden = true;

        // Accept accountId from either params.accountId or params.account (Auth spread)
        const accountId = params.accountId || params.account;

        // Populate org provisioning for orgs the account belongs to
        if (this.storage && accountId) {
            const account = await this.storage.get(Account, accountId);
            provisioning.orgs = await Promise.all(
                account.orgs.map(async (orgInfo) => {
                    const orgProv = new OrgProv();
                    orgProv.orgId = orgInfo.id;
                    orgProv.owner = { email: params.email, accountId };
                    orgProv.status = ProvisioningStatus.Active;
                    orgProv.quota.members = await this._getSeatLimit(orgInfo.id);
                    return orgProv;
                })
            );
        }

        return provisioning;
    }

    /** Seat cap for an org: -1 (unlimited) unless an explicit `OrgSeatAllocation` is on record. */
    private async _getSeatLimit(orgId: string): Promise<number> {
        if (!this.storage) {
            return -1;
        }
        try {
            const allocation = await this.storage.get(OrgSeatAllocation, orgId);
            return allocation.seats;
        } catch (e) {
            if (e.code !== ErrorCode.NOT_FOUND) {
                throw e;
            }
            return -1;
        }
    }

    /**
     * Set (or clear, with `seats: -1`) the seat allocation for an org. The plan/seat admin
     * surface for this padloc-internal goal — G020 wires a real caller (Firefly seat billing) up
     * to this.
     */
    async setOrgSeats(orgId: string, seats: number): Promise<void> {
        if (!this.storage) {
            throw new Err(ErrorCode.SERVER_ERROR, "OrgAwareProvisioner requires storage to set seat allocations");
        }
        await this.storage.save(new OrgSeatAllocation({ id: orgId, orgId, seats }));
    }

    async accountDeleted(_params: { email: string; accountId?: AccountID }): Promise<void> {
        debugLog("accountDeleted", { hasAccountId: Boolean(_params.accountId) });
    }

    async accountEmailChanged(_params: { prevEmail: string; newEmail: string; accountId?: AccountID }): Promise<void> {
        debugLog("accountEmailChanged", { hasAccountId: Boolean(_params.accountId) });
    }

    async orgDeleted(_params: OrgInfo): Promise<void> {
        debugLog("orgDeleted", { hasOrgId: Boolean(_params.id) });
    }

    async orgOwnerChanged(
        _org: OrgInfo,
        _prevOwner: { email: string; id?: AccountID },
        _newOwner: { email: string; id?: AccountID }
    ): Promise<void> {
        debugLog("orgOwnerChanged", {
            hasOrgId: Boolean(_org.id),
            hadPreviousOwnerId: Boolean(_prevOwner.id),
            hasNewOwnerId: Boolean(_newOwner.id),
        });
    }
}
