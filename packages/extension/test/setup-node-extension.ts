type ChromeCallback = (...args: unknown[]) => void;
type MochaCallable = (...args: unknown[]) => unknown;

type ChromeEvent = {
    addListener: ChromeCallback;
    removeListener: ChromeCallback;
    hasListener: () => boolean;
    hasListeners: () => boolean;
};

type ChromeStorageArea = {
    get: ChromeCallback;
    set: ChromeCallback;
    remove: ChromeCallback;
    clear: ChromeCallback;
    setAccessLevel?: ChromeCallback;
};

type ChromeTestApi = {
    runtime: {
        id: string;
        lastError?: { message?: string };
        getURL: (path: string) => string;
        sendMessage: ChromeCallback;
        sendNativeMessage: ChromeCallback;
        onMessage: ChromeEvent;
        onInstalled: ChromeEvent;
        onStartup: ChromeEvent;
    };
    storage: {
        local: ChromeStorageArea;
        session: ChromeStorageArea;
    };
    tabs: {
        query: ChromeCallback;
        sendMessage: ChromeCallback;
        executeScript: ChromeCallback;
        onUpdated: ChromeEvent;
        onActivated: ChromeEvent;
    };
    alarms: {
        create: ChromeCallback;
        clear: ChromeCallback;
        onAlarm: ChromeEvent;
    };
    commands: {
        onCommand: ChromeEvent;
    };
    contextMenus: {
        create: ChromeCallback;
        remove: ChromeCallback;
        removeAll: ChromeCallback;
        onClicked: ChromeEvent;
    };
    identity: {
        launchWebAuthFlow: ChromeCallback;
    };
    action: {
        setBadgeText: ChromeCallback;
        setBadgeBackgroundColor: ChromeCallback;
        setIcon: ChromeCallback;
        setTitle: ChromeCallback;
        openPopup: ChromeCallback;
    };
};

type NodeExtensionGlobal = typeof globalThis & {
    atob: (value: string) => string;
    btoa: (value: string) => string;
    chrome: ChromeTestApi;
    PublicKeyCredential: {
        new (): object;
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean>;
    };
    window: typeof globalThis;
};

// Loaded before Node unit tests that import browser-extension-only modules.
function callbackWith(args: unknown[], value?: unknown) {
    const maybeCallback = args[args.length - 1];
    if (typeof maybeCallback === "function") {
        maybeCallback(value);
    }
}

function eventApi(): ChromeEvent {
    return {
        addListener: () => undefined,
        removeListener: () => undefined,
        hasListener: () => false,
        hasListeners: () => false,
    };
}

function storageArea(): ChromeStorageArea {
    return {
        get: (...args: unknown[]) => callbackWith(args, {}),
        set: (...args: unknown[]) => callbackWith(args),
        remove: (...args: unknown[]) => callbackWith(args),
        clear: (...args: unknown[]) => callbackWith(args),
        setAccessLevel: (...args: unknown[]) => callbackWith(args),
    };
}

function callbackApi(value?: unknown): ChromeCallback {
    return (...args: unknown[]) => callbackWith(args, value);
}

const chromeApi: ChromeTestApi = {
    runtime: {
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path.replace(/^\/+/, "")}`,
        sendMessage: callbackApi(),
        sendNativeMessage: callbackApi(),
        onMessage: eventApi(),
        onInstalled: eventApi(),
        onStartup: eventApi(),
    },
    storage: {
        local: storageArea(),
        session: storageArea(),
    },
    tabs: {
        query: callbackApi([]),
        sendMessage: callbackApi(),
        executeScript: callbackApi(),
        onUpdated: eventApi(),
        onActivated: eventApi(),
    },
    alarms: {
        create: callbackApi(),
        clear: callbackApi(),
        onAlarm: eventApi(),
    },
    commands: {
        onCommand: eventApi(),
    },
    contextMenus: {
        create: callbackApi(""),
        remove: callbackApi(),
        removeAll: callbackApi(),
        onClicked: eventApi(),
    },
    identity: {
        launchWebAuthFlow: callbackApi(),
    },
    action: {
        setBadgeText: callbackApi(),
        setBadgeBackgroundColor: callbackApi(),
        setIcon: callbackApi(),
        setTitle: callbackApi(),
        openPopup: callbackApi(),
    },
};

const extensionGlobal = globalThis as NodeExtensionGlobal;

extensionGlobal.atob = extensionGlobal.atob || ((value: string) => Buffer.from(value, "base64").toString("binary"));
extensionGlobal.btoa = extensionGlobal.btoa || ((value: string) => Buffer.from(value, "binary").toString("base64"));
extensionGlobal.chrome = chromeApi;
extensionGlobal.window = globalThis;
extensionGlobal.PublicKeyCredential =
    extensionGlobal.PublicKeyCredential ||
    class PublicKeyCredential {
        static async isUserVerifyingPlatformAuthenticatorAvailable() {
            return false;
        }
    };

const mochaGlobals = globalThis as typeof globalThis & {
    describe?: MochaCallable;
    it?: MochaCallable;
    beforeEach?: MochaCallable;
    afterEach?: MochaCallable;
};

Object.defineProperties(globalThis, {
    suite: {
        configurable: true,
        get: () => mochaGlobals.describe,
    },
    test: {
        configurable: true,
        get: () => mochaGlobals.it,
    },
    setup: {
        configurable: true,
        get: () => mochaGlobals.beforeEach,
    },
    teardown: {
        configurable: true,
        get: () => mochaGlobals.afterEach,
    },
});
