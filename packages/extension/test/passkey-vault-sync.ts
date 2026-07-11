import { expect } from "chai";
import { App } from "@padloc/core/src/app";
import { VaultItem } from "@padloc/core/src/item";
import { Vault } from "@padloc/core/src/vault";

function strictSyncHarness(syncResult: Vault | null, clearItemChange = false) {
    const vault = new Vault();
    vault.id = "vault-1";
    const item = new VaultItem({ id: "passkey-item-1" });
    vault.items.update(item);

    const app = Object.create(App.prototype) as App & {
        syncVault: () => Promise<Vault | null>;
        getVault: () => Vault;
    };
    app.syncVault = async () => {
        if (clearItemChange) vault.items.clearChanges();
        return syncResult;
    };
    app.getVault = () => vault;
    return { app, vault, item };
}

suite("Strict passkey vault synchronization", () => {
    test("rejects when fetching the remote vault did not produce a result", async () => {
        const { app, vault, item } = strictSyncHarness(null);
        let error: unknown;
        try {
            await app.syncVaultStrict(vault, [item.id]);
        } catch (caught) {
            error = caught;
        }
        expect(error).to.be.instanceOf(Error);
        expect(vault.items.hasChange(item.id)).to.equal(true);
    });

    test("rejects when an update returns without acknowledging the item mutation", async () => {
        const { app, vault, item } = strictSyncHarness(new Vault());
        let error: unknown;
        try {
            await app.syncVaultStrict(vault, [item.id]);
        } catch (caught) {
            error = caught;
        }
        expect(error).to.be.instanceOf(Error);
        expect(vault.items.hasChange(item.id)).to.equal(true);
    });

    test("returns only after the server-acknowledged item mutation is cleared", async () => {
        const { app, vault, item } = strictSyncHarness(vaultPlaceholder(), true);
        expect(await app.syncVaultStrict(vault, [item.id])).to.equal(vault);
        expect(vault.items.hasChange(item.id)).to.equal(false);
    });
});

function vaultPlaceholder(): Vault {
    const vault = new Vault();
    vault.id = "remote-vault-1";
    return vault;
}
