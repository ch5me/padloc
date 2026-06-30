import { browser } from "webextension-polyfill-ts";
import { App } from "@padloc/app/src/elements/app";
import { debounce } from "@padloc/core/src/util";
import { Storable } from "@padloc/core/src/storage";
import { VaultItem } from "@padloc/core/src/item";
import { shouldAttemptBiometricReunlock, unlockWithBiometric } from "./auth/biometric";
import { AgenticAutofillApprovalPrompt, messageTab, SavePrompt } from "./message";
import { clearSessionMasterKey, getSessionMasterKey, saveSessionMasterKey } from "./storage";
import { installUnlockPersistenceHooks } from "./unlock-persistence";
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
    private _pendingSavePrompt: SavePrompt | null = null;
    private _savePromptOverlay: HTMLElement | null = null;
    private _pendingAutofillApproval: AgenticAutofillApprovalPrompt | null = null;
    private _autofillApprovalOverlay: HTMLElement | null = null;
    private _unlockHooksInstalled = false;
    private _sessionSyncPromise: Promise<void> | null = null;

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

    private _installUnlockPersistenceHooks() {
        if (this._unlockHooksInstalled) {
            return;
        }

        installUnlockPersistenceHooks(this.app, () => this._persistUnlockedState());

        this._unlockHooksInstalled = true;
    }

    private async _persistUnlockedState() {
        if (this._sessionSyncPromise) {
            return this._sessionSyncPromise;
        }

        this._sessionSyncPromise = this._saveSessionMasterKey().finally(() => {
            this._sessionSyncPromise = null;
        });

        await this._sessionSyncPromise;
        this._notifyUnlockedState();
    }

    async load() {
        this._installUnlockPersistenceHooks();

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
                    await this._unlocked();
                } catch (error) {
                    await clearSessionMasterKey();
                }
            }

            if (
                shouldAttemptBiometricReunlock({
                    locked: this.app.state.locked,
                    hasSessionMasterKey: !!masterKey,
                    hasRememberedMasterKey: !!this.app.state.rememberedMasterKey,
                })
            ) {
                await this._restoreBiometricUnlock();
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

        this.addEventListener("field-clicked", (event: Event) => {
            const e = event as CustomEvent<{ item: VaultItem; index: number }>;
            return this._fieldClicked(e);
        });
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

        if (this._isLocked !== this.app.state.locked) {
            this._isLocked = this.app.state.locked;
            if (this._isLocked) {
                await this._locked();
            } else {
                await this._unlocked();
            }
        }

        if (this._isLoggedIn !== this.app.state.loggedIn) {
            this._isLoggedIn = this.app.state.loggedIn;
            if (this._isLoggedIn) {
                await this._loggedIn();
            } else {
                await this._loggedOut();
            }
        }

        notifyStateChanged();
    }

    async _unlocked() {
        if (!this.state.account || !this.state.account.masterKey) {
            return;
        }
        void this._persistUnlockedState();
        this._wrapper.classList.toggle("active", true);
        void this._checkForSavePrompt();
        void this._checkForAgenticAutofillApproval();
    }

    async _locked() {
        await this._syncLockedState("locked");
    }

    private async _restoreBiometricUnlock() {
        const result = await unlockWithBiometric(this.app);
        if (result === "unlocked") {
            this._unlocked();
            return true;
        }
        return false;
    }

    async _loggedIn() {
        await browser.runtime.sendMessage({
            type: "loggedIn",
        });
    }

    async _loggedOut() {
        await this._syncLockedState("loggedOut");
    }

    private async _saveSessionMasterKey() {
        if (!this.state.account?.masterKey || !this.app.account || !this.app.session) {
            return;
        }

        await saveSessionMasterKey({
            accountId: this.app.account.id,
            sessionId: this.app.session.id,
            masterKey: this.state.account.masterKey,
        });
    }

    private _notifyUnlockedState() {
        void browser.runtime.sendMessage({ type: "unlocked" }).catch(() => undefined);
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

    protected async _fieldClicked(e: CustomEvent<{ item: VaultItem; index: number }>) {
        const { item, index } = e.detail;
        const field = item.fields[index];
        if (!field) return;
        const value = await field.transform();
        await messageTab({ type: "fillActive", value });
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

    private async _checkForSavePrompt() {
        if (this.app.state.locked || !this.app.state.loggedIn) return;

        try {
            const response = await browser.runtime.sendMessage({ type: "getSavePrompt" });
            if (response?.type === "getSavePromptResponse" && response.prompt) {
                this._pendingSavePrompt = response.prompt;
                this._renderSavePromptOverlay();
            }
        } catch {
            // Worker may not be ready
        }
    }

    private _renderSavePromptOverlay() {
        if (!this._pendingSavePrompt) return;

        const prompt = this._pendingSavePrompt;
        const hostname = (() => {
            try {
                return new URL(prompt.url).hostname;
            } catch {
                return prompt.url;
            }
        })();

        const isUpdate = !!prompt.existingItem;

        const overlayHtml = `
            <div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="lock" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">${isUpdate ? "Update Login?" : "Save Login?"}</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${hostname}</div>
                        <div class="save-prompt-username">
                            <span class="save-prompt-label">Username</span>
                            <span class="save-prompt-value">${this._escapeHtml(prompt.username) || "(empty)"}</span>
                        </div>
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Password</span>
                            <span class="save-prompt-value">${prompt.password ? "••••••••" : "(empty)"}</span>
                        </div>
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="save-prompt-action">
                            ${isUpdate ? "Update" : "Save"}
                        </button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="save-prompt-dismiss">
                            Not Now
                        </button>
                    </div>
                </div>
            </div>
        `;

        this._wrapper.insertAdjacentHTML("beforeend", overlayHtml);
        this._savePromptOverlay = this._wrapper.querySelector(".save-prompt-overlay");

        if (this._savePromptOverlay) {
            this._savePromptOverlay.querySelector("#save-prompt-action")?.addEventListener("click", () => {
                void this._handleSavePromptAction(isUpdate);
            });
            this._savePromptOverlay.querySelector("#save-prompt-dismiss")?.addEventListener("click", () => {
                void this._handleDismissPrompt();
            });
        }
    }

    private async _checkForAgenticAutofillApproval() {
        if (this.app.state.locked || !this.app.state.loggedIn) return;

        try {
            const response = await browser.runtime.sendMessage({ type: "getAgenticAutofillApprovalPrompt" });
            if (response?.type === "getAgenticAutofillApprovalPromptResponse" && response.prompt) {
                this._pendingAutofillApproval = response.prompt;
                this._renderAgenticAutofillApprovalOverlay();
            }
        } catch {
            // Worker may not be ready
        }
    }

    private _renderAgenticAutofillApprovalOverlay() {
        if (!this._pendingAutofillApproval || this._autofillApprovalOverlay) return;

        const prompt = this._pendingAutofillApproval;
        const fieldRows = prompt.fields
            .map(
                (field) => `
                    <div class="save-prompt-username">
                        <span class="save-prompt-label">${this._escapeHtml(field.role)}</span>
                        <span class="save-prompt-value">${this._escapeHtml(field.itemName)} / ${this._escapeHtml(field.fieldName)} (${this._escapeHtml(field.valuePreview)})</span>
                    </div>
                `
            )
            .join("");
        const overlayHtml = `
            <div class="save-prompt-overlay">
                <div class="save-prompt-card">
                    <div class="save-prompt-header">
                        <pl-icon icon="lock" class="save-prompt-icon"></pl-icon>
                        <span class="save-prompt-title">Approve Autofill?</span>
                    </div>
                    <div class="save-prompt-body">
                        <div class="save-prompt-host">${this._escapeHtml(prompt.origin)}</div>
                        ${fieldRows}
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Payment fields</span>
                            <span class="save-prompt-value">${prompt.paymentFieldCount}</span>
                        </div>
                        <div class="save-prompt-password">
                            <span class="save-prompt-label">Transaction-only fields</span>
                            <span class="save-prompt-value">${prompt.transactionOnlyCount}</span>
                        </div>
                        ${
                            prompt.finalSubmitWarning
                                ? `<div class="save-prompt-password">
                                    <span class="save-prompt-label">Final submit</span>
                                    <span class="save-prompt-value">Separate human approval required</span>
                                </div>`
                                : ""
                        }
                    </div>
                    <div class="save-prompt-actions">
                        <button class="save-prompt-btn save-prompt-btn-primary" id="agentic-autofill-approve">Approve</button>
                        <button class="save-prompt-btn save-prompt-btn-dismiss" id="agentic-autofill-dismiss">Not Now</button>
                    </div>
                </div>
            </div>
        `;

        this._wrapper.insertAdjacentHTML("beforeend", overlayHtml);
        this._autofillApprovalOverlay = this._wrapper.querySelector(".save-prompt-overlay:last-child");
        this._autofillApprovalOverlay?.querySelector("#agentic-autofill-approve")?.addEventListener("click", () => {
            void this._handleAgenticAutofillApproval();
        });
        this._autofillApprovalOverlay?.querySelector("#agentic-autofill-dismiss")?.addEventListener("click", () => {
            void this._handleAgenticAutofillDismiss();
        });
    }

    private _dismissAgenticAutofillApprovalOverlay() {
        if (this._autofillApprovalOverlay) {
            this._autofillApprovalOverlay.remove();
            this._autofillApprovalOverlay = null;
        }
        this._pendingAutofillApproval = null;
    }

    private async _handleAgenticAutofillApproval() {
        if (!this._pendingAutofillApproval) return;
        const planId = this._pendingAutofillApproval.planId;
        const promptNonce = this._pendingAutofillApproval.promptNonce;
        this._dismissAgenticAutofillApprovalOverlay();
        await browser.runtime.sendMessage({ type: "approveAgenticAutofill", planId, promptNonce });
    }

    private async _handleAgenticAutofillDismiss() {
        if (!this._pendingAutofillApproval) return;
        const planId = this._pendingAutofillApproval.planId;
        this._dismissAgenticAutofillApprovalOverlay();
        await browser.runtime.sendMessage({ type: "dismissAgenticAutofill", planId });
    }

    private _dismissSavePromptOverlay() {
        if (this._savePromptOverlay) {
            this._savePromptOverlay.remove();
            this._savePromptOverlay = null;
        }
        this._pendingSavePrompt = null;
    }

    private async _handleSavePromptAction(isUpdate: boolean) {
        if (!this._pendingSavePrompt) return;
        const promptId = this._pendingSavePrompt.id;
        this._dismissSavePromptOverlay();
        try {
            if (isUpdate) {
                await browser.runtime.sendMessage({ type: "updateCredential", promptId });
            } else {
                await browser.runtime.sendMessage({ type: "saveCredential", promptId });
            }
        } catch {
            // Silently handle - user can still see the updated item in the list
        }
    }

    private async _handleDismissPrompt() {
        if (!this._pendingSavePrompt) return;
        const promptId = this._pendingSavePrompt.id;
        this._dismissSavePromptOverlay();
        try {
            await browser.runtime.sendMessage({ type: "dismissPrompt", promptId });
        } catch {
            // Silently handle
        }
    }

    private _escapeHtml(str: string): string {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

if (!customElements.get("pl-extension-app")) {
    customElements.define("pl-extension-app", ExtensionApp);
}
