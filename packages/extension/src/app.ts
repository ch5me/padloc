import { browser } from "webextension-polyfill-ts";
import { App } from "@padloc/app/src/elements/app";
import { debounce } from "@padloc/core/src/util";
import { Storable } from "@padloc/core/src/storage";
import { VaultItem } from "@padloc/core/src/item";
import { clearSessionMasterKey, getSessionMasterKey, saveSessionMasterKey } from "./storage";
// import { messageTab } from "./message";

const notifyStateChanged = debounce(() => {
    browser.runtime.sendMessage({
        type: "state-changed",
    });
}, 500);

// Minimum time to wait for worker to settle after cold start (ms)
const WORKER_SETTLE_MIN_WAIT = 100;
const WORKER_SETTLE_MAX_WAIT = 500;

class RouterState extends Storable {
    id = "";
    path = "";
    params: { [key: string]: string } = {};
    lastMatchingItems: string[] = [];

    constructor(vals: Partial<RouterState> = {}) {
        super();
        Object.assign(this, vals);
    }
}

export class ExtensionApp extends App {
    private _isLocked = true;
    private _isLoggedIn = false;
    private _workerReady = false;

    private get _matchingItems() {
        return this.app.state.context.browser?.url ? this.app.getItemsForUrl(this.app.state.context.browser.url) : [];
    }

    /**
     * Wait for the background worker to be ready after cold start.
     * MV3 service workers can restart at any time, so we give the worker
     * a brief window to initialize before making routing decisions.
     */
    private async _waitForWorkerReady(): Promise<void> {
        if (this._workerReady) return;

        // Check if worker is already initialized by trying to send a ping
        // If the worker was just restarted, this gives it time to boot
        const start = Date.now();
        const maxWait = WORKER_SETTLE_MAX_WAIT;

        while (Date.now() - start < maxWait) {
            try {
                const response = await browser.runtime.sendMessage({ type: "ping" });
                if (response?.type === "pong") {
                    this._workerReady = true;
                    return;
                }
            } catch {
                // Worker is still starting, wait and retry
            }
            await new Promise((r) => setTimeout(r, WORKER_SETTLE_MIN_WAIT));
        }

        // Worker didn't respond to ping, but continue anyway
        // The worker might be in a state where it can't respond but is still functional
        this._workerReady = true;
    }

    async load() {
        // Capture active tab BEFORE calling super.load() to avoid stateChanged race.
        // stateChanged fires during super.load() and uses state.context.browser,
        // so it must be set correctly before that happens.
        const [tab] = await browser.tabs.query({ currentWindow: true, active: true });

        // Wait for worker to settle on cold start before making routing decisions
        await this._waitForWorkerReady();

        await super.load();

        // Now set browser context after super.load() completes
        this.app.state.context.browser = tab;

        if (this.app.state.locked) {
            const masterKey = await getSessionMasterKey({
                accountId: this.app.account?.id,
                sessionId: this.app.session?.id,
            });
            if (masterKey) {
                try {
                    await this.app.unlockWithMasterKey(masterKey);
                    this._unlocked();
                } catch (error) {
                    await clearSessionMasterKey();
                }
            }
        }

        const routerState = await this._getRouterState();
        const matchingItems = this._matchingItems;
        const hasNewMatchingItems =
            matchingItems.length !== routerState.lastMatchingItems.length ||
            matchingItems.some(({ item }) => !routerState.lastMatchingItems.includes(item.id));

        // Determine the correct route:
        // - If we have matching items for the current tab AND they're new or we're on items without search, show items
        // - Otherwise restore the saved router state
        if (
            matchingItems.length &&
            (hasNewMatchingItems || (routerState.path === "items" && !routerState.params.search))
        ) {
            this.router.go("items", { host: "true" }, true);
            this._saveRouterState();
        } else {
            this.router.go(routerState.path || "vaults", routerState.params, true);
        }

        this.router.addEventListener("route-changed", () => this._saveRouterState());
        this.router.addEventListener("params-changed", () => this._saveRouterState());

        // this.addEventListener("field-clicked", (e: any) => this._fieldClicked(e));
        this.addEventListener("field-dragged", (e: any) => this._fieldDragged(e));

        // this._autoFill(
        //     new CustomEvent("auto-fill", {
        //         detail: {
        //             item: {
        //                 name: "Test",
        //                 fields: [
        //                     { name: "username", value: "martin@maklesoft.com" },
        //                     { name: "password", value: "mypassword" }
        //                 ]
        //             } as VaultItem,
        //             index: 0
        //         }
        //     })
        // );
    }

    async stateChanged() {
        super.stateChanged();
        notifyStateChanged();
        if (this._isLocked !== this.app.state.locked) {
            this._isLocked = this.app.state.locked;
            this._isLocked ? this._locked() : this._unlocked();
        }

        if (this._isLoggedIn !== this.app.state.loggedIn) {
            this._isLoggedIn = this.app.state.loggedIn;
            this._isLoggedIn ? this._loggedIn() : this._loggedOut();
        }
    }

    _unlocked() {
        if (!this.state.account || !this.state.account.masterKey) {
            return;
        }
        this._wrapper.classList.toggle("active", true);
        void this._syncUnlockedState();

        // if (this._hasMatchingItems) {
        //     this.router.go("items", { host: "true" }, true);
        // }
    }

    _locked() {
        void this._syncLockedState("locked");
    }

    _loggedIn() {
        browser.runtime.sendMessage({
            type: "loggedIn",
        });
    }

    _loggedOut() {
        void this._syncLockedState("loggedOut");
    }

    private async _syncUnlockedState() {
        if (!this.state.account?.masterKey || !this.app.account || !this.app.session) {
            return;
        }

        await saveSessionMasterKey({
            accountId: this.app.account.id,
            sessionId: this.app.session.id,
            masterKey: this.state.account.masterKey,
        });

        await browser.runtime.sendMessage({ type: "unlocked" });
    }

    private async _syncLockedState(type: "locked" | "loggedOut") {
        await clearSessionMasterKey();
        await browser.runtime.sendMessage({ type });
    }

    private async _getRouterState() {
        try {
            return await this.app.storage.get(RouterState, "");
        } catch (e) {
            return new RouterState();
        }
    }

    private async _saveRouterState() {
        const { host, ...params } = this.router.params;
        const lastMatchingItems = this._matchingItems.map(({ item }) => item.id);
        await this.app.storage.save(new RouterState({ path: this.router.path, params, lastMatchingItems }));
    }

    protected async _fieldDragged(e: CustomEvent<{ item: VaultItem; index: number; event: DragEvent }>) {
        super._fieldDragged(e);

        const event = e.detail.event;

        const dragleave = () => {
            document.body.style.width = "0";
            document.body.style.height = "0";
            document.body.style.opacity = "0";
        };

        const dragend = () => {
            document.body.style.width = "";
            document.body.style.height = "";
            document.body.style.opacity = "1";
            document.removeEventListener("dragleave", dragleave);
        };

        // const drag = (e: DragEvent) => {
        //     console.log("drag", e);
        // };

        document.addEventListener("dragleave", dragleave, { once: true });
        event.target!.addEventListener("dragend", dragend, { once: true });
        // document.addEventListener("drag", drag);

        // const field = item.fields[index];
        // const value = await transformedValue(field);
        //
        // await messageTab({
        //     type: "fillOnDrop",
        //     value
        // });
    }
}

customElements.define("pl-extension-app", ExtensionApp);
