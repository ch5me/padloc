import {
    PasskeyCeremonyBinding,
    PasskeyCeremonyTarget,
    validatePasskeyCeremonyBinding,
} from "@padloc/core/src/passkey";

export interface PasskeyRequestSender {
    url?: string;
    frameId?: number;
    documentId?: string;
    tab?: { id?: number; url?: string; documentId?: string };
}

export interface PasskeyRequestContract {
    flowId: string;
    nonce: string;
    ttlMs: number;
    topOrigin: string;
    rpId: string;
    target: {
        frameId: 0;
        origin: string;
        topOrigin: string;
        documentId: string;
    };
}

export interface PasskeyRequestBinding {
    origin: string;
    tabId: number;
    frameId: 0;
    flowId?: string;
    nonce?: string;
    ttlMs?: number;
    expiresAt?: number;
    topOrigin?: string;
    rpId?: string;
    documentId?: string;
    target?: PasskeyCeremonyTarget;
}

const consumedBindings = new WeakSet<object>();

export function bindPasskeyRequest(
    origin: string,
    sender: PasskeyRequestSender,
    contract?: PasskeyRequestContract,
    now = Date.now()
): PasskeyRequestBinding | null {
    let senderOrigin: string | null = null;
    try {
        senderOrigin = sender.url ? new URL(sender.url).origin : null;
    } catch {
        senderOrigin = null;
    }
    if (
        sender.frameId !== 0 ||
        typeof sender.tab?.id !== "number" ||
        senderOrigin === null ||
        senderOrigin === "null" ||
        senderOrigin !== origin
    ) {
        return null;
    }
    const base = { origin, tabId: sender.tab.id, frameId: 0 as const };
    if (!contract) return Object.freeze(base);

    if (
        contract.target.origin !== origin ||
        contract.target.topOrigin !== contract.topOrigin ||
        contract.target.frameId !== 0 ||
        (sender.documentId && sender.documentId !== contract.target.documentId) ||
        (sender.tab.documentId && sender.tab.documentId !== contract.target.documentId)
    ) {
        return null;
    }

    const target: PasskeyCeremonyTarget = Object.freeze({
        tabId: sender.tab.id,
        frameId: 0,
        origin,
        topOrigin: contract.topOrigin,
        documentId: contract.target.documentId,
    });
    const binding: PasskeyCeremonyBinding = {
        flowId: contract.flowId,
        nonce: contract.nonce,
        ttlMs: contract.ttlMs,
        expiresAt: now + contract.ttlMs,
        topOrigin: contract.topOrigin,
        rpId: contract.rpId,
        target,
    };
    try {
        validatePasskeyCeremonyBinding(binding, now);
    } catch {
        return null;
    }

    // Keep the historical three-key shape enumerable for existing consumers,
    // while exposing the stronger ceremony contract to the passkey worker.
    return Object.freeze(
        Object.defineProperties(base, {
            flowId: { configurable: false, enumerable: false, value: binding.flowId },
            nonce: { configurable: false, enumerable: false, value: binding.nonce },
            ttlMs: { configurable: false, enumerable: false, value: binding.ttlMs },
            expiresAt: { configurable: false, enumerable: false, value: binding.expiresAt },
            topOrigin: { configurable: false, enumerable: false, value: binding.topOrigin },
            rpId: { configurable: false, enumerable: false, value: binding.rpId },
            documentId: { configurable: false, enumerable: false, value: binding.target.documentId },
            target: { configurable: false, enumerable: false, value: binding.target },
        })
    ) as PasskeyRequestBinding;
}

export function isPasskeyRequestBindingCurrent(
    binding: PasskeyRequestBinding,
    tab: { id?: number; url?: string; documentId?: string },
    now = Date.now()
): boolean {
    if (tab.id !== binding.tabId || !tab.url) return false;
    if (binding.expiresAt !== undefined && (!Number.isFinite(binding.expiresAt) || now >= binding.expiresAt)) {
        return false;
    }
    if (binding.documentId && tab.documentId && tab.documentId !== binding.documentId) return false;
    try {
        const tabOrigin = new URL(tab.url).origin;
        return tabOrigin === binding.origin && (!binding.topOrigin || tabOrigin === binding.topOrigin);
    } catch {
        return false;
    }
}

export function consumePasskeyRequestBinding(binding: PasskeyRequestBinding, nonce: string, now = Date.now()): boolean {
    if (!binding.nonce || binding.nonce !== nonce || consumedBindings.has(binding)) return false;
    if (binding.expiresAt === undefined || !Number.isFinite(binding.expiresAt) || now >= binding.expiresAt)
        return false;
    consumedBindings.add(binding);
    return true;
}

export function passkeyRequestBindingCeremony(binding: PasskeyRequestBinding): PasskeyCeremonyBinding | null {
    if (
        !binding.flowId ||
        !binding.nonce ||
        binding.ttlMs === undefined ||
        binding.expiresAt === undefined ||
        !binding.topOrigin ||
        !binding.rpId ||
        !binding.target
    ) {
        return null;
    }
    return {
        flowId: binding.flowId,
        nonce: binding.nonce,
        ttlMs: binding.ttlMs,
        expiresAt: binding.expiresAt,
        topOrigin: binding.topOrigin,
        rpId: binding.rpId,
        target: binding.target,
    };
}
