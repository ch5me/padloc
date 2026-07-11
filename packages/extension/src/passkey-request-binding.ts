export interface PasskeyRequestSender {
    url?: string;
    frameId?: number;
    tab?: { id?: number };
}

export interface PasskeyRequestBinding {
    origin: string;
    tabId: number;
    frameId: 0;
}

export function bindPasskeyRequest(origin: string, sender: PasskeyRequestSender): PasskeyRequestBinding | null {
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
    return Object.freeze({ origin, tabId: sender.tab.id, frameId: 0 });
}

export function isPasskeyRequestBindingCurrent(
    binding: PasskeyRequestBinding,
    tab: { id?: number; url?: string }
): boolean {
    if (tab.id !== binding.tabId || !tab.url) return false;
    try {
        return new URL(tab.url).origin === binding.origin;
    } catch {
        return false;
    }
}
