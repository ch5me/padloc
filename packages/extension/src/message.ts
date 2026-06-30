import { browser } from "webextension-polyfill-ts";
import { VaultItem } from "@padloc/core/src/item";
import { AutofillBrokerRequest, AutofillBrokerResponse } from "./autofill-broker-protocol";

/**
 * Mapping of field role to value for multi-field fill orchestration.
 * Legacy login keys stay supported while the Padloc/Magic Browser bridge grows
 * identity, address, and transaction-only payment roles.
 */
export type FieldMappings = {
    username?: string;
    password?: string;
    totp?: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    cardholderName?: string;
    cardNumber?: string;
    cardExpiry?: string;
    cardExpiryMonth?: string;
    cardExpiryYear?: string;
    cardCvv?: string;
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

export interface AgenticAutofillApprovalPrompt {
    planId: string;
    promptNonce: string;
    origin: string;
    fieldCount: number;
    transactionOnlyCount: number;
    paymentFieldCount: number;
    finalSubmitWarning: boolean;
    fields: Array<{
        role: string;
        itemName: string;
        fieldName: string;
        valuePreview: string;
        transactionOnly: boolean;
    }>;
}

export interface AgenticWebAuthnCreateRequest {
    requestId: string;
    rpId: string;
    origin: string;
    topOrigin?: string;
    crossOrigin?: boolean;
    challenge: string;
    clientDataJSON: string;
    userHandle?: string;
    userName?: string;
    userDisplayName?: string;
    algorithm?: number;
    userVerification?: UserVerificationRequirement;
    excludeCredentialIds?: string[];
}

export interface AgenticWebAuthnGetRequest {
    requestId: string;
    rpId: string;
    origin: string;
    topOrigin?: string;
    crossOrigin?: boolean;
    challenge: string;
    clientDataJSON: string;
    clientDataHash: string;
    userVerification?: UserVerificationRequirement;
    allowCredentialIds?: string[];
}

export type AgenticWebAuthnErrorName =
    | "InvalidStateError"
    | "NotAllowedError"
    | "NotSupportedError"
    | "SecurityError"
    | "UnknownError";

export interface AgenticWebAuthnCredentialResponse {
    id: string;
    rawId: string;
    type: "public-key";
    authenticatorAttachment: "platform" | "cross-platform";
    clientExtensionResults: { credProps?: { rk: boolean } };
    response: {
        clientDataJSON: string;
        attestationObject?: string;
        authenticatorData?: string;
        publicKey?: string;
        publicKeyAlgorithm?: number;
        signature?: string;
        userHandle?: string;
        transports?: string[];
    };
}

export type AgenticWebAuthnResponse =
    | { ok: true; credential: AgenticWebAuthnCredentialResponse; valuePolicy: string }
    | { ok: false; error: { name: AgenticWebAuthnErrorName; message: string; reason?: string }; valuePolicy: string };

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
    | { type: "dismissPrompt"; promptId: string }
    | { type: "getAgenticAutofillApprovalPrompt" }
    | { type: "getAgenticAutofillApprovalPromptResponse"; prompt: AgenticAutofillApprovalPrompt | null }
    | { type: "approveAgenticAutofill"; planId: string; promptNonce: string }
    | { type: "dismissAgenticAutofill"; planId: string }
    | { type: "seedAgenticAutofillFixtures" }
    | { type: "seedAgenticAutofillFixturesResponse"; created: number; itemNames: string[]; valuePolicy: string }
    | { type: "agenticAutofillBroker"; request: AutofillBrokerRequest }
    | { type: "agenticAutofillBrokerResponse"; response: AutofillBrokerResponse }
    | { type: "agenticWebAuthnCreate"; request: AgenticWebAuthnCreateRequest }
    | { type: "agenticWebAuthnGet"; request: AgenticWebAuthnGetRequest }
    | { type: "agenticWebAuthnResponse"; response: AgenticWebAuthnResponse };

export async function messageTab(msg: Message) {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
        const contentReady: boolean = await browser.tabs
            .sendMessage(activeTab.id!, { type: "isContentReady" })
            .catch(() => false);

        if (!contentReady) {
            await browser.tabs.executeScript(activeTab.id, { file: "/content.js" });
        }

        return browser.tabs.sendMessage(activeTab.id!, msg);
    } else {
        return Promise.resolve();
    }
}
