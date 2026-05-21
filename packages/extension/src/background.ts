import { browser, Menus, Runtime } from "webextension-polyfill-ts";
import { setPlatform } from "@padloc/core/src/platform";
import { App } from "@padloc/core/src/app";
import { AjaxSender } from "@padloc/app/src/lib/ajax";
import { debounce } from "@padloc/core/src/util";
import { ExtensionPlatform } from "./platform";
import { Message, messageTab } from "./message";
import { clearSessionMasterKey, configureSessionStorage, getSessionMasterKey } from "./storage";

setPlatform(new ExtensionPlatform());

// MV3 service worker - state must be persisted to storage
let app: App;
let autoLockAlarmName = "pl_autoLock";
let isInitialized = false;
const actionApi = chrome.action;

async function getApp(): Promise<App> {
    if (!app) {
        app = new App(new AjaxSender(process.env.PL_SERVER_URL!));
        await app.load();
        await restoreSessionUnlock(app);
    } else if (app.state.locked) {
        await restoreSessionUnlock(app);
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

    const match = menuItemId.match(/^item\/([^\/]+)(?:\/(\d+))?$/);
    if (!match) return;

    const [, id, ind] = match;
    const application = await getApp();
    const item = application.getItem(id);
    const index = parseInt(ind);
    if (!item || isNaN(index)) return;

    const field = item.item.fields[index];
    const value = await field.transform();
    await messageTab({ type: "fillActive", value });
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
            await browser.contextMenus.create({
                id: `item/${item.id}`,
                title: item.name,
                contexts: ["editable"],
            });

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
        actionApi.setTitle({ title: process.env.PL_APP_NAME || "" });
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

// Initialize on install
browser.runtime.onInstalled.addListener(initBackground);

// Initialize on startup (service worker may be dormant)
browser.runtime.onStartup.addListener(initBackground);

// Also try to initialize immediately in case already installed
initBackground().catch(console.error);
