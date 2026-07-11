import { Account, AccountID } from "@padloc/core/src/account";
import { OrgInfo } from "@padloc/core/src/org";
import {
    Provisioner,
    Provisioning,
    ProvisioningStatus,
    OrgProvisioning as OrgProv,
} from "@padloc/core/src/provisioning";
import { Session } from "@padloc/core/src/session";
import { Storage } from "@padloc/core/src/storage";

function debugLog(...args: unknown[]) {
    typeof console !== "undefined" && console.debug("[PersonalProvisioner]", ...args);
}

export class PersonalProvisioner implements Provisioner {
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
            provisioning.orgs = account.orgs.map((orgInfo) => {
                const orgProv = new OrgProv();
                orgProv.orgId = orgInfo.id;
                orgProv.owner = { email: params.email, accountId };
                orgProv.status = ProvisioningStatus.Active;
                return orgProv;
            });
        }

        return provisioning;
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
