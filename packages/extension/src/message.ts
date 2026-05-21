import { browser } from "webextension-polyfill-ts";
import { VaultItem } from "@padloc/core/src/item";

/**
 * Mapping of field role to value for multi-field fill orchestration.
 * username, password, totp are optional — only present when a field of that type exists.
 */
export type FieldMappings = {
    username?: string;
    password?: string;
    totp?: string;
};

/**
 * Credential data captured from a form submission for save/update prompts.
 */
export interface CredentialData {
    username: string;
    password: string;
    url: string;
}

/**
 * Pending save/update prompt state tracked in the background service worker.
 */
export interface SavePrompt {
    id: string;
    url: string;
    username: string;
    password: string;
    existingItem?: VaultItem;
    dismissedUntil?: number; // timestamp when prompt can be shown again
}

export type Message =
    | { type: "loggedIn" }
    | { type: "loggedOut" }
    | { type: "locked" }
    | { type: "unlocked" }
    | { type: "fillActive"; value: string }
    | { type: "fillFields"; mappings: FieldMappings }
    | { type: "fillOnDrop"; value: string }
    | { type: "calcTOTP"; secret: string }
    | { type: "isContentReady" }
    | { type: "hasActiveInput" }
    | { type: "state-changed" }
    | { type: "ping" }
    | { type: "pong" } // pong response from worker
    | { type: "formSubmitDetected"; data: CredentialData }
    | { type: "getSavePrompt" }
    | { type: "getSavePromptResponse"; prompt: SavePrompt | null }
    | { type: "saveCredential"; promptId: string; vaultId?: string }
    | { type: "updateCredential"; promptId: string; vaultId?: string }
    | { type: "dismissPrompt"; promptId: string };

export async function messageTab(msg: Message) {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
        let contentReady = false;
        try {
            contentReady = await browser.tabs.sendMessage(activeTab.id!, { type: "isContentReady" });
        } catch (e) {}

        if (!contentReady) {
            await browser.tabs.executeScript(activeTab.id, { file: "/content.js" });
        }

        return browser.tabs.sendMessage(activeTab.id!, msg);
    } else {
        return Promise.resolve();
    }
}
