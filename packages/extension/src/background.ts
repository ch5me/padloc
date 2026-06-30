import { browser, Menus, Runtime } from "webextension-polyfill-ts";
import { setPlatform } from "@padloc/core/src/platform";
import { App } from "@padloc/core/src/app";
import { uuid } from "@padloc/core/src/util";
import { base64ToBytes, bytesToBase64 } from "@padloc/core/src/encoding";
import {
    AutofillFieldRole,
    FieldType,
    Field,
    PasskeyCredentialPolicy,
    isPasskeyCredentialItem,
    VaultItem,
} from "@padloc/core/src/item";
import { BackgroundExtensionPlatform } from "./background-platform";
import {
    AgenticAutofillApprovalPrompt,
    AgenticWebAuthnCreateRequest,
    AgenticWebAuthnErrorName,
    AgenticWebAuthnGetRequest,
    AgenticWebAuthnResponse,
    FieldMappings,
    Message,
    messageTab,
    SavePrompt,
    CredentialData,
} from "./message";
import { clearSessionMasterKey, configureSessionStorage, getSessionMasterKey } from "./storage";
import { BackgroundFetchSender } from "./background-fetch-sender";
import { AutofillBrokerRequest, AutofillBrokerResponse, buildLockedBrokerResponse } from "./autofill-broker-protocol";
import {
    applyBrokerBundleResponse,
    approveBrokerPlanResponse,
    buildUnlockedBrokerPlanResponse,
    BrokerApproval,
    mintBrokerBundleResponse,
    PendingBrokerPlan,
    redactBrokerResponse,
    revokeBrokerBundleResponse,
} from "./autofill-broker";
import { enrollPasskeyCredential, requestPasskeyAssertion } from "./passkey-broker";

setPlatform(new BackgroundExtensionPlatform());

const API_BASE_URL = process.env.PL_SERVER_URL!;

// MV3 service worker - state must be persisted to storage
let app: App;
let autoLockAlarmName = "pl_autoLock";
let nativeBrokerAlarmName = "pl_agenticAutofillNativeBroker";
let isInitialized = false;
let immediateMessageBridgeRegistered = false;
const actionApi = chrome.action;
let badgeAndContextMenuUpdateChain = Promise.resolve();

// Save/update credential prompt state
// Maps promptId -> pending SavePrompt
const pendingPrompts = new Map<string, SavePrompt>();
const pendingAutofillPlans = new Map<string, PendingBrokerPlan>();
const pendingAutofillApprovals = new Map<string, BrokerApproval>();
const pendingAutofillBundles = new Map<string, AutofillBrokerResponse>();
const pendingAutofillPromptNonces = new Map<string, { nonce: string; senderUrl: string }>();

// Suppression map: url -> timestamp when prompt can be shown again
const dismissedUrls = new Map<string, number>();

const DISMISSAL_DURATION_MS = 60 * 60 * 1000; // 1 hour
const WEBAUTHN_APP_READY_TIMEOUT_MS = 5000;

// MV3 wake events are dispatched to listeners registered during service-worker
// evaluation. Register the fail-fast WebAuthn bridge before async app init.
registerImmediateMessageBridge();

async function getApp(): Promise<App> {
    if (!app) {
        app = new App(new BackgroundFetchSender(API_BASE_URL));
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

async function getAppWithin(timeoutMs: number): Promise<App | null> {
    let timeoutId: number | undefined;
    try {
        return await Promise.race([
            getApp(),
            new Promise<null>((resolve) => {
                timeoutId = setTimeout(() => resolve(null), timeoutMs) as unknown as number;
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
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

    const update = debounceBackground(() => {
        void enqueueBadgeAndContextMenuUpdate().catch((error) => console.error(error));
    }, 500);
    registerImmediateMessageBridge();

    // Message listener - handles communication from popup and other contexts.
    // Keep this listener synchronous so it cannot consume immediate bridge
    // messages by resolving an async undefined response first.
    browser.runtime.onMessage.addListener((msg: Message, sender: Runtime.MessageSender) => {
        if (msg.type === "ping" || msg.type === "agenticWebAuthnCreate" || msg.type === "agenticWebAuthnGet") {
            return;
        }
        const senderUrl = sender.url || "";
        const isExtensionUiSender = senderUrl.startsWith(browser.runtime.getURL(""));
        if (sender.tab && !isExtensionUiSender) {
            // Ignore legacy content-script messages; WebAuthn has an explicit page bridge.
            return;
        }
        return handleExtensionMessage(msg, sender, update);
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
        if (alarm.name === nativeBrokerAlarmName) {
            await processPendingNativeBrokerRequest(await getApp());
        }
    });

    // Register commands
    browser.commands.onCommand.addListener(async () => {
        // Commands are handled via popup for MV3
    });

    await configureSessionStorage();
    const _app = await getApp();
    _app.subscribe(update);
    await enqueueBadgeAndContextMenuUpdate();
    browser.alarms.create(nativeBrokerAlarmName, { periodInMinutes: 1 });
    void processPendingNativeBrokerRequest(_app);
}

function debounceBackground(fn: () => void, delay: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(fn, delay);
    };
}

function enqueueBadgeAndContextMenuUpdate() {
    badgeAndContextMenuUpdateChain = badgeAndContextMenuUpdateChain
        .catch(() => undefined)
        .then(() => updateBadgeAndContextMenu());
    return badgeAndContextMenuUpdateChain;
}

async function handleExtensionMessage(msg: Message, sender: Runtime.MessageSender, update: () => void) {
    const application = await getApp();

    switch (msg.type) {
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
        case "getAgenticAutofillApprovalPrompt":
            return handleGetAgenticAutofillApprovalPrompt(sender);
        case "approveAgenticAutofill":
            return handleApproveAgenticAutofill(msg.planId, msg.promptNonce, sender);
        case "dismissAgenticAutofill":
            return handleDismissAgenticAutofill(msg.planId);
        case "seedAgenticAutofillFixtures":
            return handleSeedAgenticAutofillFixtures(sender, application);
        case "agenticAutofillBroker":
            return handleAgenticAutofillBroker(msg.request, application);
    }
}

function registerImmediateMessageBridge() {
    if (immediateMessageBridgeRegistered) return;
    immediateMessageBridgeRegistered = true;
    const chromeRuntime = (
        chrome as typeof chrome & {
            runtime: {
                onMessage: {
                    addListener(
                        listener: (
                            msg: Message,
                            sender: Runtime.MessageSender,
                            sendResponse: (response?: unknown) => void
                        ) => boolean | void
                    ): void;
                };
            };
        }
    ).runtime;
    chromeRuntime.onMessage.addListener(
        (msg: Message, sender: Runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
            if (!msg || typeof msg !== "object") return false;
            if (msg.type === "ping") {
                void getApp().then((application) => processPendingNativeBrokerRequest(application));
                sendResponse({ type: "pong" });
                return false;
            }
            if (msg.type === "agenticWebAuthnCreate" || msg.type === "agenticWebAuthnGet") {
                void handleImmediateWebAuthnMessage(msg, sender)
                    .then(sendResponse)
                    .catch((error) =>
                        sendResponse(
                            webAuthnMessage(
                                denyWebAuthn(
                                    "UnknownError",
                                    error instanceof Error ? error.message : "Padloc passkey broker failed",
                                    "broker_failed"
                                )
                            )
                        )
                    );
                return true;
            }
            return false;
        }
    );
}

async function handleImmediateWebAuthnMessage(
    msg: Extract<Message, { type: "agenticWebAuthnCreate" | "agenticWebAuthnGet" }>,
    sender: Runtime.MessageSender
) {
    const webAuthnApp = await getAppWithin(WEBAUTHN_APP_READY_TIMEOUT_MS);
    if (!webAuthnApp) {
        return webAuthnMessage(
            denyWebAuthn("NotAllowedError", "Padloc background app not initialized", "background_not_ready")
        );
    }
    return msg.type === "agenticWebAuthnCreate"
        ? handleAgenticWebAuthnCreate(msg.request, sender, webAuthnApp)
        : handleAgenticWebAuthnGet(msg.request, sender, webAuthnApp);
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
        const fallbackField = fields.find((f: Field) => f.type === FieldType.Password || f.type === FieldType.Username);
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
            title: `${count2 > 1 ? `${count2} items` : "1 item"} found${
                !openPopupAvailable ? " (unlock to view)" : ""
            }`,
            enabled: openPopupAvailable,
            contexts: ["editable"],
        });
    } else {
        const menuIds = new Set<string>();
        const items = dedupeMatchedItems(await getItemsForActiveTab());
        for (const { item } of items) {
            const hasUsername = item.fields.some((f) => f.type === FieldType.Username);
            const hasPassword = item.fields.some((f) => f.type === FieldType.Password);
            // Top-level item — clicking it triggers multi-field fill if credentials exist
            await createContextMenuOnce(menuIds, {
                id: `item/${item.id}`,
                title: hasUsername && hasPassword ? `${item.name}  ▸  Fill Login` : item.name,
                contexts: ["editable"],
            });

            // Single-field sub-items
            for (const [index, field] of item.fields.entries()) {
                await createContextMenuOnce(menuIds, {
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

function dedupeMatchedItems(items: MatchedVaultItem[]): MatchedVaultItem[] {
    const seen = new Set<string>();
    const deduped: MatchedVaultItem[] = [];
    for (const item of items) {
        if (seen.has(item.item.id)) continue;
        seen.add(item.item.id);
        deduped.push(item);
    }
    return deduped;
}

async function createContextMenuOnce(
    menuIds: Set<string>,
    createProperties: Menus.CreateCreatePropertiesType
): Promise<void> {
    if (!createProperties.id) throw new Error("Context menu id required");
    if (menuIds.has(createProperties.id)) return;
    menuIds.add(createProperties.id);
    try {
        await browser.contextMenus.create(createProperties);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("duplicate id")) {
            throw error;
        }
        await browser.contextMenus.remove(createProperties.id).catch(() => undefined);
        await browser.contextMenus.create(createProperties);
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

function getAllVaultItems(application: App) {
    return Array.from(application.vaults).flatMap((vault) => Array.from(vault.items));
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
    const existingLogin = existingItems.find(({ item }) => item.fields.some((f) => f.type === FieldType.Password));

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

async function handleSaveCredential(promptId: string, vaultId: string | undefined, application: App): Promise<null> {
    const prompt = pendingPrompts.get(promptId);
    if (!prompt) return null;

    pendingPrompts.delete(promptId);

    if (application.state.locked || !application.state.loggedIn) return null;

    const vault = vaultId ? application.getVault(vaultId!) : application.mainVault;

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

async function handleUpdateCredential(promptId: string, _vaultId: string | undefined, application: App): Promise<null> {
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

function handleGetAgenticAutofillApprovalPrompt(sender: Runtime.MessageSender): {
    type: "getAgenticAutofillApprovalPromptResponse";
    prompt: AgenticAutofillApprovalPrompt | null;
} {
    const latest = Array.from(pendingAutofillPlans.values()).pop();
    if (!latest) return { type: "getAgenticAutofillApprovalPromptResponse", prompt: null };
    const senderUrl = requireExtensionUiSender(sender);
    const promptNonce = randomApprovalPromptNonce();
    pendingAutofillPromptNonces.set(latest.planId, { nonce: promptNonce, senderUrl });
    return {
        type: "getAgenticAutofillApprovalPromptResponse",
        prompt: {
            planId: latest.planId,
            promptNonce,
            origin: latest.request.binding ? latest.request.binding.origin : "unknown",
            fieldCount: latest.fields.length,
            transactionOnlyCount: latest.fields.filter((field) => field.transactionOnly).length,
            paymentFieldCount: latest.fields.filter((field) => field.role.startsWith("payment.")).length,
            finalSubmitWarning:
                latest.request.fields?.some(
                    (field) => field.finalSubmit === true || (field.role || "").startsWith("purchase.final_submit")
                ) ?? false,
            fields: latest.fields.map((field) => ({
                role: field.role,
                itemName: field.itemName,
                fieldName: field.fieldName,
                valuePreview: field.valuePreview,
                transactionOnly: field.transactionOnly,
            })),
        },
    };
}

function handleApproveAgenticAutofill(planId: string, promptNonce: string, sender: Runtime.MessageSender) {
    const plan = pendingAutofillPlans.get(planId);
    if (!plan) throw new Error("Autofill approval plan not found");
    const senderUrl = requireExtensionUiSender(sender);
    const expected = pendingAutofillPromptNonces.get(planId);
    if (!expected || promptNonce !== expected.nonce || senderUrl !== expected.senderUrl) {
        throw new Error("Autofill approval requires active approval UI nonce");
    }
    pendingAutofillPromptNonces.delete(planId);
    const { response, approval } = approveBrokerPlanResponse(
        {
            type: "approve",
            protocolVersion: 1,
            requestId: `popup-${planId}`,
            planId,
            approved: true,
            binding: plan.request.binding,
        },
        plan
    );
    pendingAutofillApprovals.set(approval.approvalId, approval);
    void publishRedactedBrokerResponse(response);
    return { type: "agenticAutofillBrokerResponse", response };
}

function handleDismissAgenticAutofill(planId: string): null {
    pendingAutofillPlans.delete(planId);
    pendingAutofillPromptNonces.delete(planId);
    for (const [approvalId, approval] of pendingAutofillApprovals.entries()) {
        if (approval.planId === planId) pendingAutofillApprovals.delete(approvalId);
    }
    return null;
}

async function handleAgenticWebAuthnCreate(
    request: AgenticWebAuthnCreateRequest,
    sender: Runtime.MessageSender,
    application: App
): Promise<{ type: "agenticWebAuthnResponse"; response: AgenticWebAuthnResponse }> {
    const validation = validatePageWebAuthnRequest(request, sender);
    if (validation) return webAuthnMessage(validation);
    if (application.state.locked || !application.state.loggedIn) {
        return webAuthnMessage(denyWebAuthn("NotAllowedError", "Padloc vault locked", "vault_locked"));
    }
    if (
        request.excludeCredentialIds?.some((credentialId) => findPasskeyItemByCredentialId(application, credentialId))
    ) {
        return webAuthnMessage(
            denyWebAuthn("InvalidStateError", "Passkey already exists in Padloc", "credential_excluded")
        );
    }

    const vault = application.mainVault;
    if (!vault) return webAuthnMessage(denyWebAuthn("NotAllowedError", "No writable Padloc vault", "vault_missing"));

    try {
        const result = await enrollPasskeyCredential({
            type: "enroll-passkey",
            protocolVersion: 1,
            requestId: request.requestId,
            binding: {
                sessionId: "padloc-extension-webauthn",
                origin: request.origin,
                topOrigin: request.topOrigin || request.origin,
                rpId: request.rpId,
                vendor: request.rpId,
            },
            passkey: {
                itemName: request.userName ? `${request.rpId} ${request.userName}` : `Passkey ${request.rpId}`,
                rpId: request.rpId,
                topOrigin: request.topOrigin || request.origin,
                userHandle: request.userHandle,
                algorithm: request.algorithm,
                clientDataHash: bytesToBase64(
                    new Uint8Array(await crypto.subtle.digest("SHA-256", base64ToBytesLoose(request.clientDataJSON)))
                ),
                userVerification: request.userVerification,
                vendor: request.rpId,
                policy: new PasskeyCredentialPolicy({
                    allowedRpIds: [request.rpId],
                    allowedTopOrigins: defaultAllowedTopOrigins(request.rpId, request.origin, request.topOrigin),
                    allowedVendorFlows: [request.rpId],
                    approval: "none",
                    rateLimit: {},
                    timeWindows: [],
                    requireFlowBinding: false,
                    emergencyLockout: false,
                }),
            },
        });
        const createdItem = await application.createItem({
            name: result.itemName,
            vault: { id: vault.id },
            icon: result.icon,
            fields: result.fields,
            itemKind: result.itemKind,
            passkeyCredential: result.passkeyCredential,
        });
        if (result.response.passkey) {
            result.response.passkey.itemId = createdItem.id;
            result.response.passkey.itemName = createdItem.name;
        }
        void publishRedactedBrokerResponse(result.response);
        const registration = result.response.passkey?.registration;
        if (!registration) {
            return webAuthnMessage(
                denyWebAuthn("UnknownError", "Padloc passkey registration missing", "registration_missing")
            );
        }
        return webAuthnMessage({
            ok: true,
            credential: {
                id: toBrowserBase64Url(registration.credentialId),
                rawId: toBrowserBase64Url(registration.credentialId),
                type: "public-key",
                authenticatorAttachment: registration.authenticatorAttachment,
                clientExtensionResults: registration.clientExtensionResults,
                response: {
                    clientDataJSON: request.clientDataJSON,
                    attestationObject: toBrowserBase64Url(registration.attestationObject),
                    authenticatorData: toBrowserBase64Url(registration.authenticatorData),
                    publicKey: toBrowserBase64Url(registration.publicKeySpki),
                    publicKeyAlgorithm: Number(registration.algorithm),
                    transports: registration.transports,
                },
            },
            valuePolicy: "redacted WebAuthn registration only; private key stays in Padloc signer store",
        });
    } catch (error) {
        return webAuthnMessage(
            denyWebAuthn(
                "UnknownError",
                error instanceof Error ? error.message : "Padloc passkey registration failed",
                "registration_failed"
            )
        );
    }
}

async function handleAgenticWebAuthnGet(
    request: AgenticWebAuthnGetRequest,
    sender: Runtime.MessageSender,
    application: App
): Promise<{ type: "agenticWebAuthnResponse"; response: AgenticWebAuthnResponse }> {
    const validation = validatePageWebAuthnRequest(request, sender);
    if (validation) return webAuthnMessage(validation);
    if (application.state.locked || !application.state.loggedIn) {
        return webAuthnMessage(denyWebAuthn("NotAllowedError", "Padloc vault locked", "vault_locked"));
    }

    const item = selectPasskeyItem(application, request);
    if (!item) {
        return webAuthnMessage(denyWebAuthn("NotAllowedError", "No matching Padloc passkey", "credential_not_found"));
    }

    try {
        const nonce = await uuid();
        const result = await requestPasskeyAssertion(
            {
                type: "request-assertion",
                protocolVersion: 1,
                requestId: request.requestId,
                binding: {
                    sessionId: "padloc-extension-webauthn",
                    origin: request.origin,
                    topOrigin: request.topOrigin || request.origin,
                    rpId: request.rpId,
                    vendor: request.rpId,
                    nonce,
                },
                passkey: {
                    credentialId: item.passkeyCredential.credentialId,
                    rpId: request.rpId,
                    topOrigin: request.topOrigin || request.origin,
                    clientDataHash: request.clientDataHash,
                    challenge: request.challenge,
                    userVerification: request.userVerification,
                    nonce,
                    vendor: request.rpId,
                },
            },
            getAllVaultItems(application)
        );
        if (result.updatedItem?.id) {
            await application.updateItem(result.updatedItem, {
                itemKind: result.updatedItem.itemKind,
                passkeyCredential: result.updatedItem.passkeyCredential,
            });
        }
        void publishRedactedBrokerResponse(result.response);
        const assertion = result.response.passkey?.assertion;
        if (!result.response.ok || !assertion) {
            return webAuthnMessage(
                denyWebAuthn(
                    "NotAllowedError",
                    result.response.reason || "Padloc passkey assertion denied",
                    result.response.passkey?.reasonCode || "assertion_denied"
                )
            );
        }
        return webAuthnMessage({
            ok: true,
            credential: {
                id: toBrowserBase64Url(assertion.credentialId),
                rawId: toBrowserBase64Url(assertion.credentialId),
                type: "public-key",
                authenticatorAttachment: "platform",
                clientExtensionResults: {},
                response: {
                    clientDataJSON: request.clientDataJSON,
                    authenticatorData: toBrowserBase64Url(assertion.authenticatorData),
                    signature: toBrowserBase64Url(assertion.signature),
                    userHandle: toBrowserBase64Url(assertion.userHandle),
                },
            },
            valuePolicy: "redacted WebAuthn assertion only; private key stays in Padloc signer store",
        });
    } catch (error) {
        return webAuthnMessage(
            denyWebAuthn(
                "UnknownError",
                error instanceof Error ? error.message : "Padloc passkey assertion failed",
                "assertion_failed"
            )
        );
    }
}

function randomApprovalPromptNonce(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requireExtensionUiSender(sender: Runtime.MessageSender): string {
    const senderUrl = sender.url || "";
    const extensionOrigin = `chrome-extension://${browser.runtime.id}/`;
    if (!senderUrl.startsWith(extensionOrigin)) {
        throw new Error("Autofill approval requires Padloc extension UI sender");
    }
    return senderUrl;
}

function validatePageWebAuthnRequest(
    request: AgenticWebAuthnCreateRequest | AgenticWebAuthnGetRequest,
    sender: Runtime.MessageSender
): AgenticWebAuthnResponse | null {
    const senderUrl = sender.url || sender.tab?.url || "";
    let senderOrigin = "";
    try {
        senderOrigin = new URL(senderUrl).origin;
    } catch {
        return denyWebAuthn("SecurityError", "Padloc WebAuthn request missing sender origin", "sender_origin_missing");
    }
    if (senderOrigin !== request.origin) {
        return denyWebAuthn("SecurityError", "Padloc WebAuthn origin mismatch", "origin_mismatch");
    }
    const topOrigin = request.topOrigin || request.origin;
    if (request.crossOrigin && !request.topOrigin) {
        return denyWebAuthn(
            "SecurityError",
            "Padloc WebAuthn cross-origin request missing top origin",
            "top_origin_missing"
        );
    }
    if (request.crossOrigin) {
        return denyWebAuthn(
            "NotSupportedError",
            "Padloc WebAuthn cross-origin frames are not supported",
            "cross_origin_not_supported"
        );
    }
    if (sender.tab?.url && request.topOrigin) {
        try {
            const senderTopOrigin = new URL(sender.tab.url).origin;
            if (senderTopOrigin !== request.topOrigin) {
                return denyWebAuthn("SecurityError", "Padloc WebAuthn top origin mismatch", "top_origin_mismatch");
            }
        } catch {
            return denyWebAuthn(
                "SecurityError",
                "Padloc WebAuthn sender top origin invalid",
                "sender_top_origin_invalid"
            );
        }
    }
    if (!rpIdMatchesOrigin(request.rpId, topOrigin)) {
        return denyWebAuthn("SecurityError", "Padloc WebAuthn rpId not allowed for origin", "rp_id_origin_mismatch");
    }
    return null;
}

function rpIdMatchesOrigin(rpId: string, origin: string): boolean {
    try {
        const hostname = normalizeWebAuthnDomain(new URL(origin).hostname);
        const normalizedRpId = normalizeWebAuthnDomain(rpId);
        if (!hostname || !normalizedRpId || isForbiddenRpId(normalizedRpId)) return false;
        if (hostname === "localhost" && normalizedRpId === "localhost") return true;
        return hostname === normalizedRpId || hostname.endsWith(`.${normalizedRpId}`);
    } catch {
        return false;
    }
}

function normalizeWebAuthnDomain(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\.$/, "");
    if (!normalized || normalized.includes("/") || normalized.includes(":")) return null;
    if (normalized.length > 253) return null;
    const labels = normalized.split(".");
    if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label))) return null;
    return normalized;
}

function isForbiddenRpId(rpId: string): boolean {
    if (rpId === "localhost") return false;
    if (!rpId.includes(".")) return true;
    if (isIpAddress(rpId)) return true;
    return PUBLIC_SUFFIX_RP_IDS.has(rpId);
}

function isIpAddress(value: string): boolean {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
        return value.split(".").every((part) => Number(part) <= 255);
    }
    return value.includes(":");
}

const PUBLIC_SUFFIX_RP_IDS = new Set([
    "app",
    "co.jp",
    "co.uk",
    "com",
    "com.au",
    "com.br",
    "com.cn",
    "com.mx",
    "com.tr",
    "co.nz",
    "dev",
    "edu",
    "gov",
    "io",
    "net",
    "ne.jp",
    "org",
    "org.uk",
    "uk",
    "us",
]);

function selectPasskeyItem(
    application: App,
    request: AgenticWebAuthnGetRequest
): (VaultItem & { passkeyCredential: NonNullable<VaultItem["passkeyCredential"]> }) | null {
    const allowedIds = request.allowCredentialIds || [];
    const matches = getAllVaultItems(application)
        .filter(isPasskeyCredentialItem)
        .filter((item) => item.passkeyCredential.rpId === request.rpId)
        .filter(
            (item) => !allowedIds.length || allowedIds.includes(toBrowserBase64Url(item.passkeyCredential.credentialId))
        );
    if (matches.length !== 1) return null;
    return matches[0];
}

function defaultAllowedTopOrigins(rpId: string, origin: string, topOrigin?: string): string[] {
    return Array.from(new Set([topOrigin || origin, origin, `https://${rpId}`].filter(Boolean)));
}

function findPasskeyItemByCredentialId(application: App, credentialId: string): VaultItem | null {
    const normalizedCredentialId = toBrowserBase64Url(credentialId);
    return (
        getAllVaultItems(application)
            .filter(isPasskeyCredentialItem)
            .find((item) => toBrowserBase64Url(item.passkeyCredential.credentialId) === normalizedCredentialId) || null
    );
}

function webAuthnMessage(response: AgenticWebAuthnResponse): {
    type: "agenticWebAuthnResponse";
    response: AgenticWebAuthnResponse;
} {
    return { type: "agenticWebAuthnResponse", response };
}

function denyWebAuthn(name: AgenticWebAuthnErrorName, message: string, reason: string): AgenticWebAuthnResponse {
    return {
        ok: false,
        error: { name, message, reason },
        valuePolicy: "redacted WebAuthn denial only; no private key material",
    };
}

function toBrowserBase64Url(value: string): string {
    return bytesToBase64(base64ToBytesLoose(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytesLoose(value: string): Uint8Array {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return base64ToBytes(padded);
}

async function handleSeedAgenticAutofillFixtures(sender: Runtime.MessageSender, application: App) {
    requireExtensionUiSender(sender);
    if (application.state.locked || !application.state.loggedIn) {
        throw new Error("Fixture seeding requires unlocked Padloc extension UI");
    }
    const vault = application.mainVault;
    if (!vault) throw new Error("Fixture seeding requires a main vault");
    const fixtures = buildAgenticAutofillFixtureItems();
    for (const fixture of fixtures) {
        await application.createItem({
            name: fixture.name,
            vault: { id: vault.id },
            fields: fixture.fields,
            tags: ["agentic-autofill-fixture"],
            icon: fixture.icon,
        });
    }
    return {
        type: "seedAgenticAutofillFixturesResponse",
        created: fixtures.length,
        itemNames: fixtures.map((fixture) => fixture.name),
        valuePolicy: "fake fixture values only; response contains item names and counts, no raw field values",
    };
}

function buildAgenticAutofillFixtureItems(): Array<{ name: string; icon: string; fields: Field[] }> {
    return [
        {
            name: "Agentic Autofill Fixture - Person",
            icon: "user",
            fields: [
                new Field({
                    name: "Full Name",
                    value: "Pat Fixture",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.PersonFullName,
                }),
                new Field({
                    name: "First Name",
                    value: "Pat",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.PersonFirstName,
                }),
                new Field({
                    name: "Last Name",
                    value: "Fixture",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.PersonLastName,
                }),
                new Field({
                    name: "Email",
                    value: "fixture@example.test",
                    type: FieldType.Email,
                    autofillRole: AutofillFieldRole.ContactEmail,
                }),
                new Field({
                    name: "Phone",
                    value: "5550100000",
                    type: FieldType.Phone,
                    autofillRole: AutofillFieldRole.ContactPhone,
                }),
            ],
        },
        {
            name: "Agentic Autofill Fixture - Address",
            icon: "passport",
            fields: [
                new Field({
                    name: "Address Line 1",
                    value: "100 Fixture Way",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressLine1,
                }),
                new Field({
                    name: "Address Line 2",
                    value: "Unit 10",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressLine2,
                }),
                new Field({
                    name: "City",
                    value: "Fixture City",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressCity,
                }),
                new Field({
                    name: "State",
                    value: "CA",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressRegion,
                }),
                new Field({
                    name: "Postal Code",
                    value: "90001",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressPostalCode,
                }),
                new Field({
                    name: "Country",
                    value: "US",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.AddressCountry,
                }),
            ],
        },
        {
            name: "Agentic Autofill Fixture - Payment Card",
            icon: "credit",
            fields: [
                new Field({
                    name: "Card Number",
                    value: "4111111111111111",
                    type: FieldType.Credit,
                    autofillRole: AutofillFieldRole.PaymentCardPan,
                }),
                new Field({
                    name: "Card Owner",
                    value: "Pat Fixture",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.PaymentCardholderName,
                }),
                new Field({
                    name: "Valid Until",
                    value: "2031-09",
                    type: FieldType.Month,
                    autofillRole: AutofillFieldRole.PaymentCardExpiry,
                }),
                new Field({
                    name: "CVC",
                    value: "123",
                    type: FieldType.Pin,
                    autofillRole: AutofillFieldRole.PaymentCardCvvTransient,
                    transactionOnly: true,
                }),
            ],
        },
        {
            name: "Agentic Autofill Fixture - Gift Recipient",
            icon: "user",
            fields: [
                new Field({
                    name: "Recipient Name",
                    value: "Gift Fixture",
                    type: FieldType.Text,
                    autofillRole: AutofillFieldRole.PersonFullName,
                }),
                new Field({
                    name: "Recipient Email",
                    value: "gift.fixture@example.test",
                    type: FieldType.Email,
                    autofillRole: AutofillFieldRole.ContactEmail,
                }),
            ],
        },
        {
            name: "Agentic Autofill Fixture - Merchant",
            icon: "web",
            fields: [
                new Field({
                    name: "Merchant Origin",
                    value: "https://checkout.example.test",
                    type: FieldType.Url,
                    autofillRole: AutofillFieldRole.MerchantOrigin,
                }),
            ],
        },
    ];
}

async function handleAgenticAutofillBroker(request: AutofillBrokerRequest, application: App) {
    if (application.state.locked || !application.state.loggedIn) {
        return {
            type: "agenticAutofillBrokerResponse",
            response: buildLockedBrokerResponse(request),
        };
    }

    if (request.type === "plan-fill" || request.type === "classify") {
        const items = await getItemsForActiveTab();
        const { response, pendingPlan } = buildUnlockedBrokerPlanResponse(request, items);
        pendingAutofillPlans.set(pendingPlan.planId, pendingPlan);
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    if (request.type === "approve") {
        throw new Error("Autofill approval requires Padloc approval UI");
    }

    if (request.type === "enroll-passkey") {
        const vaultId = request.passkey && "vaultId" in request.passkey ? request.passkey.vaultId : undefined;
        const vault = vaultId ? application.getVault(vaultId) : application.mainVault;
        if (!vault) throw new Error("Passkey enrollment requires an accessible vault");
        const result = await enrollPasskeyCredential(request);
        const createdItem = await application.createItem({
            name: result.itemName,
            vault: { id: vault.id },
            icon: result.icon,
            fields: result.fields,
            itemKind: result.itemKind,
            passkeyCredential: result.passkeyCredential,
        });
        if (result.response.passkey) {
            result.response.passkey.itemId = createdItem.id;
            result.response.passkey.itemName = createdItem.name;
        }
        void publishRedactedBrokerResponse(result.response);
        return { type: "agenticAutofillBrokerResponse", response: result.response };
    }

    if (request.type === "request-assertion") {
        const result = await requestPasskeyAssertion(request, getAllVaultItems(application));
        if (result.updatedItem?.id) {
            await application.updateItem(result.updatedItem, {
                itemKind: result.updatedItem.itemKind,
                passkeyCredential: result.updatedItem.passkeyCredential,
            });
        }
        void publishRedactedBrokerResponse(result.response);
        return { type: "agenticAutofillBrokerResponse", response: result.response };
    }

    if (request.type === "mint-fill-bundle") {
        const plan = request.planId ? pendingAutofillPlans.get(request.planId) : null;
        const approval = request.approvalId ? pendingAutofillApprovals.get(request.approvalId) : null;
        if (!plan) throw new Error("Autofill bundle plan not found");
        if (!approval) throw new Error("Autofill bundle approval not found");
        const response = await mintBrokerBundleResponse(request, plan, approval, await getItemsForActiveTab());
        pendingAutofillApprovals.delete(approval.approvalId);
        const redacted = redactBrokerResponse(response);
        if (response.bundleId) pendingAutofillBundles.set(response.bundleId, response);
        void publishRedactedBrokerResponse(redacted);
        return { type: "agenticAutofillBrokerResponse", response: redacted };
    }

    if (request.type === "apply-fill-bundle") {
        const bundle = request.bundleId ? pendingAutofillBundles.get(request.bundleId) : null;
        if (!bundle) throw new Error("Autofill bundle not found");
        const response = applyBrokerBundleResponse(request, bundle);
        await fillActiveTabFromBundle(bundle);
        pendingAutofillBundles.delete(bundle.bundleId || "");
        pendingAutofillPlans.delete(bundle.planId || "");
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    if (request.type === "revoke-fill-bundle") {
        const bundle = request.bundleId ? pendingAutofillBundles.get(request.bundleId) : null;
        if (!bundle) throw new Error("Autofill bundle not found");
        const response = revokeBrokerBundleResponse(request, bundle);
        pendingAutofillBundles.delete(bundle.bundleId || "");
        pendingAutofillPlans.delete(bundle.planId || "");
        void publishRedactedBrokerResponse(response);
        return { type: "agenticAutofillBrokerResponse", response };
    }

    return {
        type: "agenticAutofillBrokerResponse",
        response: buildLockedBrokerResponse(request),
    };
}

async function fillActiveTabFromBundle(bundle: AutofillBrokerResponse): Promise<void> {
    const bundleFields = bundle.bundleFields || [];
    const mappings = bundleFieldsToMappings(bundleFields);
    if (!Object.values(mappings).some((value) => Boolean(value))) {
        throw new Error("Autofill bundle contains no fillable values");
    }
    await messageTab({ type: "fillFields", mappings });
}

function bundleFieldsToMappings(fields: NonNullable<AutofillBrokerResponse["bundleFields"]>): FieldMappings {
    const mappings: FieldMappings = {};
    for (const field of fields) {
        if (!field.value) continue;
        switch (field.role) {
            case "username":
                mappings.username = field.value;
                break;
            case "password":
                mappings.password = field.value;
                break;
            case "totp":
                mappings.totp = field.value;
                break;
            case "person.full_name":
                mappings.fullName = field.value;
                break;
            case "person.first_name":
                mappings.firstName = field.value;
                break;
            case "person.last_name":
                mappings.lastName = field.value;
                break;
            case "contact.email":
                mappings.email = field.value;
                break;
            case "contact.phone":
                mappings.phone = field.value;
                break;
            case "billing.address.line1":
            case "address.line1":
                mappings.addressLine1 = field.value;
                break;
            case "billing.address.line2":
            case "address.line2":
                mappings.addressLine2 = field.value;
                break;
            case "billing.address.city":
            case "address.city":
                mappings.city = field.value;
                break;
            case "billing.address.region":
            case "address.region":
                mappings.region = field.value;
                break;
            case "billing.address.postal_code":
            case "address.postal_code":
                mappings.postalCode = field.value;
                break;
            case "billing.address.country":
            case "address.country":
                mappings.country = field.value;
                break;
            case "payment.card.cardholder_name":
            case "payment.cardholder_name":
                mappings.cardholderName = field.value;
                break;
            case "payment.card.pan":
                mappings.cardNumber = field.value;
                break;
            case "payment.card.expiry":
            case "payment.card.expiry_mm_yy":
                mappings.cardExpiry = field.value;
                break;
            case "payment.card.expiry_month":
                mappings.cardExpiryMonth = field.value;
                break;
            case "payment.card.expiry_year":
                mappings.cardExpiryYear = field.value;
                break;
            case "payment.card.cvv_transient":
                mappings.cardCvv = field.value;
                break;
        }
    }
    return mappings;
}

async function processPendingNativeBrokerRequest(application: App): Promise<void> {
    let claimed: unknown;
    try {
        claimed = await browser.runtime.sendNativeMessage("me.ch5.padloc", {
            type: "claim-broker-request",
            protocolVersion: 1,
        });
    } catch {
        return;
    }
    if (!claimed || typeof claimed !== "object") return;
    const pending = (claimed as { pending?: unknown }).pending;
    if (!pending || typeof pending !== "object") return;
    const request = (pending as { request?: unknown }).request;
    if (!request || typeof request !== "object") return;
    try {
        await handleAgenticAutofillBroker(request as AutofillBrokerRequest, application);
    } catch (error) {
        const failedRequest = request as AutofillBrokerRequest;
        await publishRedactedBrokerResponse({
            ok: false,
            protocolVersion: 1,
            requestId: typeof failedRequest.requestId === "string" ? failedRequest.requestId : undefined,
            vaultState: application.state.locked ? "locked" : "unknown",
            reason: error instanceof Error ? error.message : "Padloc native broker request failed",
            audit: {
                operation: failedRequest.type || "status",
                sessionId: failedRequest.binding?.sessionId || null,
                origin: failedRequest.binding?.origin || null,
                fieldCount: failedRequest.fields?.length || 0,
                valuePolicy: "redacted audit only; no raw autofill values or passkey secrets",
            },
        });
    }
}

const brokerGlobal = globalThis as typeof globalThis & {
    padlocAgenticAutofillBroker?: (request: AutofillBrokerRequest) => Promise<unknown>;
};

brokerGlobal.padlocAgenticAutofillBroker = async (request: AutofillBrokerRequest) => {
    const response = await handleAgenticAutofillBroker(request, await getApp());
    return response.response;
};

async function publishRedactedBrokerResponse(response: unknown): Promise<void> {
    try {
        await browser.runtime.sendNativeMessage("me.ch5.padloc", {
            type: "cache-redacted-response",
            protocolVersion: 1,
            response,
        });
    } catch {
        // Native host is optional during extension-only tests and first-run setup.
    }
}

function startBackgroundInitialization() {
    void initBackground().catch((error) => {
        isInitialized = false;
        console.error(error);
    });
}

// Initialize on install
browser.runtime.onInstalled.addListener(startBackgroundInitialization);

// Initialize on startup (service worker may be dormant)
browser.runtime.onStartup.addListener(startBackgroundInitialization);

// Also try to initialize immediately in case already installed
startBackgroundInitialization();
