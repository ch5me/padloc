import { browser, Menus, Runtime } from "webextension-polyfill-ts";
import { setPlatform } from "@padloc/core/src/platform";
import { App } from "@padloc/core/src/app";
import { AjaxSender } from "@padloc/app/src/lib/ajax";
import { debounce, uuid } from "@padloc/core/src/util";
import { FieldType, Field } from "@padloc/core/src/item";
import { ExtensionPlatform } from "./platform";
import { Message, messageTab, SavePrompt, CredentialData } from "./message";
import { clearSessionMasterKey, configureSessionStorage, getSessionMasterKey } from "./storage";
import { buildLockedBrokerResponse } from "./autofill-broker-protocol";

setPlatform(new ExtensionPlatform());

const API_BASE_URL = "https://api-pad.ch5.me";

// MV3 service worker - state must be persisted to storage
let app: App;
let autoLockAlarmName = "pl_autoLock";
let isInitialized = false;
const actionApi = chrome.action;

// Save/update credential prompt state
// Maps promptId -> pending SavePrompt
const pendingPrompts = new Map<string, SavePrompt>();

// Suppression map: url -> timestamp when prompt can be shown again
const dismissedUrls = new Map<string, number>();

const DISMISSAL_DURATION_MS = 60 * 60 * 1000; // 1 hour

async function getApp(): Promise<App> {
    if (!app) {
        app = new App(new AjaxSender(API_BASE_URL));
        await app.load();
        if (await restoreSessionUnlock(app)) {
            await startAutoLockTimer();
        }
    } else if (app.state.locked) {
        if (await restoreSessionUnlock(app)) {
            await startAutoLockTimer();
        }
    }
    return app;
}

async function restoreSessionUnlock(application: App) {
    if (!application.state.locked || !application.account || !application.session) {
        return false;
    }

    const masterKey = await getSessionMasterKey({
        accountId: application.account.id,
        sessionId: application.session.id,
    });

    if (!masterKey) {
        return false;
    }

    try {
        await application.unlockWithMasterKey(masterKey);
        return true;
    } catch (error) {
        await clearSessionMasterKey();
        return false;
    }
}

async function initBackground() {
    if (isInitialized) return;
    isInitialized = true;

    await configureSessionStorage();

    const _app = await getApp();
    const update = debounce(() => updateBadgeAndContextMenu(), 500);
    _app.subscribe(update);

    // Message listener - handles communication from popup and other contexts
    browser.runtime.onMessage.addListener(async (msg: Message, sender: Runtime.MessageSender) => {
        if (sender.tab) {
            // Ignore messages from content scripts (one-way communication)
            return;
        }

        const application = await getApp();

        switch (msg.type) {
            case "ping":
                // Used by popup to verify worker is alive after cold start
                return { type: "pong" };
            case "loggedOut":
            case "locked":
                await clearSessionMasterKey();
                await application.load();
                await cancelAutoLock();
                await update();
                break;
            case "unlocked":
                await application.load();
                await restoreSessionUnlock(application);
                await startAutoLockTimer();
                await update();
                break;
            case "state-changed":
                await application.reload();
                await update();
                break;
            case "formSubmitDetected":
                return handleFormSubmitDetected(msg.data, application);
            case "getSavePrompt":
                return handleGetSavePrompt();
            case "saveCredential":
                return handleSaveCredential(msg.promptId, msg.vaultId, application);
            case "updateCredential":
                return handleUpdateCredential(msg.promptId, msg.vaultId, application);
            case "dismissPrompt":
                return handleDismissPrompt(msg.promptId);
            case "agenticAutofillBroker":
                return {
                    type: "agenticAutofillBrokerResponse",
                    response: buildLockedBrokerResponse(msg.request),
                };
        }
    });

    // Tab listeners for badge updates
    browser.tabs.onUpdated.addListener(update);
    browser.tabs.onActivated.addListener(update);

    // Context menu click handler
    browser.contextMenus.onClicked.addListener(async ({ menuItemId }: Menus.OnClickData) => {
        await handleContextMenuClick(menuItemId as string);
    });

    // Alarm listener for auto-lock
    browser.alarms.onAlarm.addListener(async (alarm) => {
        if (alarm.name === autoLockAlarmName) {
            await doLock();
        }
    });

    // Register commands
    browser.commands.onCommand.addListener(async () => {
        // Commands are handled via popup for MV3
    });

    await update();
}

async function handleContextMenuClick(menuItemId: string) {
    if (menuItemId === "openPopup") {
        actionApi.openPopup();
        return;
    }

    // item/{id}/{fieldIndex} — single-field fill (existing)
    const fieldMatch = menuItemId.match(/^item\/([^\/]+)\/(\d+)$/);
    if (fieldMatch) {
        const [, id, ind] = fieldMatch;
        const application = await getApp();
        const item = application.getItem(id);
        const index = parseInt(ind);
        if (!item || isNaN(index)) return;
        const field = item.item.fields[index];
        if (!field) return;
        const value = await field.transform();
        await messageTab({ type: "fillActive", value });
        return;
    }

    // item/{id} — multi-field fill (username + password, optionally TOTP)
    const itemMatch = menuItemId.match(/^item\/([^\/]+)$/);
    if (!itemMatch) return;

    const [, id] = itemMatch;
    const application = await getApp();
    const item = application.getItem(id);
    if (!item) return;

    await fillItemMultiField(item);
}

type MatchedVaultItem = NonNullable<ReturnType<App["getItem"]>>;

async function fillItemMultiField(item: MatchedVaultItem) {
    const fields = item.item.fields;
    let username: string | undefined;
    let password: string | undefined;
    let totp: string | undefined;

    for (const field of fields) {
        if (field.type === FieldType.Username && !username) {
            username = await field.transform();
        } else if (field.type === FieldType.Password && !password) {
            password = await field.transform();
        } else if (field.type === FieldType.Totp && !totp) {
            totp = await field.transform();
        }
    }

    // Require at least username or password to trigger multi-field fill
    if (!username && !password) {
        // Fall back to single-field: fill first available password or username
        const fallbackField = fields.find(
            (f: Field) => f.type === FieldType.Password || f.type === FieldType.Username
        );
        if (fallbackField) {
            const value = await fallbackField.transform();
            await messageTab({ type: "fillActive", value });
        }
        return;
    }

    await messageTab({ type: "fillFields", mappings: { username, password, totp } });
}

async function updateBadgeAndContextMenu() {
    const application = await getApp();
    const count = await getCountForActiveTab();

    // Update badge
    const badgeText = count && application.settings.extensionBadge ? count.toString() : "";
    actionApi.setBadgeText({ text: badgeText });
    actionApi.setBadgeBackgroundColor({ color: "#ff6666" });

    // Update context menu
    await browser.contextMenus.removeAll();

    const count2 = await getCountForActiveTab();
    if (!count2 || !application.state.loggedIn) return;

    if (application.state.locked) {
        const openPopupAvailable = typeof actionApi.openPopup === "function";
        await browser.contextMenus.create({
            id: "openPopup",
            title: `${count2 > 1 ? `${count2} items` : "1 item"} found${!openPopupAvailable ? " (unlock to view)" : ""}`,
            enabled: openPopupAvailable,
            contexts: ["editable"],
        });
    } else {
        const items = await getItemsForActiveTab();
        for (const { item } of items) {
            const hasUsername = item.fields.some((f) => f.type === FieldType.Username);
            const hasPassword = item.fields.some((f) => f.type === FieldType.Password);
            // Top-level item — clicking it triggers multi-field fill if credentials exist
            await browser.contextMenus.create({
                id: `item/${item.id}`,
                title: hasUsername && hasPassword ? `${item.name}  ▸  Fill Login` : item.name,
                contexts: ["editable"],
            });

            // Single-field sub-items
            for (const [index, field] of item.fields.entries()) {
                await browser.contextMenus.create({
                    parentId: `item/${item.id}`,
                    id: `item/${item.id}/${index}`,
                    title: field.name,
                    contexts: ["editable"],
                });
            }
        }
    }

    // Update icon
    if (!application.account) {
        actionApi.setIcon({ path: "icon-grayscale.png" });
        actionApi.setTitle({ title: "Please Log In" });
    } else {
        actionApi.setIcon({ path: "icon.png" });
        actionApi.setTitle({ title: "CH5 Auth" });
    }
}

async function getActiveTab() {
    const [tab] = await browser.tabs.query({ currentWindow: true, active: true });
    return tab || null;
}

async function getItemsForActiveTab() {
    const tab = await getActiveTab();
    const application = await getApp();
    return tab && tab.url ? application.getItemsForUrl(tab.url) : [];
}

async function getCountForActiveTab() {
    const tab = await getActiveTab();
    const application = await getApp();
    return tab && tab.url ? await application.state.index.matchUrl(tab.url) : 0;
}

async function cancelAutoLock() {
    await browser.alarms.clear(autoLockAlarmName);
}

async function doLock() {
    const application = await getApp();
    if (application.state.syncing) {
        await startAutoLockTimer();
        return;
    }
    await application.lock();
    await clearSessionMasterKey();
    await application.reload();
}

async function startAutoLockTimer() {
    await cancelAutoLock();
    const application = await getApp();
    if (application.settings.autoLock && !application.state.locked) {
        browser.alarms.create(autoLockAlarmName, {
            delayInMinutes: application.settings.autoLockDelay,
        });
    }
}

// Save/update credential handlers

async function handleFormSubmitDetected(data: CredentialData, application: App): Promise<null> {
    if (application.state.locked || !application.state.loggedIn) {
        return null;
    }

    // Clean up expired dismissals
    const now = Date.now();
    for (const [url, timestamp] of dismissedUrls.entries()) {
        if (now > timestamp) dismissedUrls.delete(url);
    }

    // Check if dismissed
    const dismissalTimestamp = dismissedUrls.get(data.url);
    if (dismissalTimestamp && now < dismissalTimestamp) {
        return null;
    }

    // Check for existing item for this URL
    const existingItems = application.getItemsForUrl(data.url);
    const existingLogin = existingItems.find(({ item }) =>
        item.fields.some((f) => f.type === FieldType.Password)
    );

    const promptId = await uuid();
    const prompt: SavePrompt = {
        id: promptId,
        url: data.url,
        username: data.username,
        password: data.password,
        existingItem: existingLogin?.item,
    };

    pendingPrompts.set(promptId, prompt);

    // Notify popup of pending prompt by sending state-changed
    // Popup will call getSavePrompt to retrieve the prompt
    return null;
}

function handleGetSavePrompt(): { type: "getSavePromptResponse"; prompt: SavePrompt | null } {
    // Return the most recent pending prompt (if any)
    const prompts = Array.from(pendingPrompts.values());
    const latest = prompts.length > 0 ? prompts[prompts.length - 1] : null;
    return { type: "getSavePromptResponse", prompt: latest || null };
}

async function handleSaveCredential(
    promptId: string,
    vaultId: string | undefined,
    application: App
): Promise<null> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt) return null;

    pendingPrompts.delete(promptId);

    if (application.state.locked || !application.state.loggedIn) return null;

    const vault = vaultId
        ? application.getVault(vaultId!)
        : application.mainVault;

    if (!vault) return null;

    const name = new URL(prompt.url).hostname || "Saved Login";

    const fields: Field[] = [
        new Field({ name: "username", type: FieldType.Username, value: prompt.username }),
        new Field({ name: "password", type: FieldType.Password, value: prompt.password }),
        new Field({ name: "url", type: FieldType.Url, value: prompt.url }),
    ];

    await application.createItem({
        name,
        vault: { id: vault.id },
        fields,
    });

    return null;
}

async function handleUpdateCredential(
    promptId: string,
    _vaultId: string | undefined,
    application: App
): Promise<null> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt || !prompt.existingItem) return null;

    pendingPrompts.delete(promptId);

    if (application.state.locked || !application.state.loggedIn) return null;

    const item = prompt.existingItem;
    const updatedFields = item.fields.map((f) => {
        if (f.type === FieldType.Username) {
            return new Field({ ...f, value: prompt.username });
        }
        if (f.type === FieldType.Password) {
            return new Field({ ...f, value: prompt.password });
        }
        return f;
    });

    await application.updateItem(item, { fields: updatedFields });

    return null;
}

function handleDismissPrompt(promptId: string): null {
    const prompt = pendingPrompts.get(promptId);
    if (prompt) {
        pendingPrompts.delete(promptId);
        // Suppress prompts for the same URL for 1 hour
        dismissedUrls.set(prompt.url, Date.now() + DISMISSAL_DURATION_MS);
    }
    return null;
}

// Initialize on install
browser.runtime.onInstalled.addListener(initBackground);

// Initialize on startup (service worker may be dormant)
browser.runtime.onStartup.addListener(initBackground);

// Also try to initialize immediately in case already installed
initBackground().catch(console.error);
