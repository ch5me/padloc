const { webcrypto } = require("crypto");
const Module = require("module");

const originalModuleLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "@simplewebauthn/browser") {
        return {
            async browserSupportsWebauthn() {
                return false;
            },
            async platformAuthenticatorIsAvailable() {
                return false;
            },
            async startAuthentication(data: unknown) {
                return data;
            },
            async startRegistration(data: unknown) {
                return data;
            },
        };
    }
    if (request.endsWith("elements/qr-code")) {
        return {};
    }
    const parentFile = (parent as { filename?: string } | undefined)?.filename || "";
    if (parentFile.endsWith("packages/app/src/lib/platform.ts")) {
        class StubAuthClient {
            supportsType() {
                return true;
            }
            async prepareRegistration(data: unknown) {
                return data;
            }
            async prepareAuthentication(data: unknown) {
                return data;
            }
        }
        if (request === "./auth/webauthn") {
            return { webAuthnClient: new StubAuthClient() };
        }
        if (request === "./auth/oauth") {
            return { OauthClient: StubAuthClient };
        }
        if (request === "./auth/totp") {
            return { TotpAuthCLient: StubAuthClient };
        }
        if (request === "./auth/email") {
            return { EmailAuthClient: StubAuthClient };
        }
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};

const eventTarget = {
    addListener() {},
    removeListener() {},
    hasListener() {
        return false;
    },
    hasListeners() {
        return false;
    },
};

function storageArea() {
    return {
        async get() {
            return {};
        },
        async set() {},
        async remove() {},
        async clear() {},
        async setAccessLevel() {},
    };
}

const browserMock = {
    alarms: {
        async create() {},
        async clear() {
            return false;
        },
        onAlarm: eventTarget,
    },
    contextMenus: {
        create() {
            return "";
        },
        async removeAll() {},
        onClicked: eventTarget,
    },
    identity: {
        async launchWebAuthFlow() {
            return undefined;
        },
    },
    runtime: {
        id: "padloc-test-extension",
        getURL(path: string) {
            return `chrome-extension://padloc-test-extension/${path}`;
        },
        async sendMessage() {},
        onMessage: eventTarget,
        onInstalled: eventTarget,
        onStartup: eventTarget,
    },
    storage: {
        local: storageArea(),
        session: storageArea(),
    },
    tabs: {
        async query() {
            return [];
        },
        async sendMessage() {},
        async executeScript() {},
        onUpdated: eventTarget,
        onActivated: eventTarget,
        onRemoved: eventTarget,
    },
};

const historyMock = {
    state: null,
    pushState() {},
    replaceState() {},
    go() {},
};

class TestCustomEvent<T = unknown> {
    defaultPrevented = false;
    type: string;
    detail?: T;

    constructor(type: string, init: { detail?: T } = {}) {
        this.type = type;
        this.detail = init.detail;
    }
}

class TestEvent {
    type: string;

    constructor(type: string) {
        this.type = type;
    }
}

const chromeMock = {
    runtime: {
        lastError: undefined,
        connect() {
            return {
                onMessage: eventTarget,
                onDisconnect: eventTarget,
                postMessage() {},
                disconnect() {},
            };
        },
    },
    action: {
        async setBadgeText() {},
        async setBadgeBackgroundColor() {},
        async setIcon() {},
        async setTitle() {},
        async openPopup() {},
    },
};

Object.assign(globalThis as any, {
    browser: browserMock,
    history: historyMock,
    location: { pathname: "/", search: "", href: "http://localhost/" },
    CustomEvent: TestCustomEvent,
    InputEvent: TestEvent,
    KeyboardEvent: TestEvent,
    CSS: {
        escape(value: string) {
            return value.replace(/([.: ])/g, "\\$1");
        },
    },
    chrome: chromeMock,
});

Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
});
Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Padloc extension unit test", language: "en" },
});

Object.assign(globalThis as any, {
    window: globalThis,
    self: globalThis,
    addEventListener() {},
    removeEventListener() {},
    open() {
        return null;
    },
    matchMedia() {
        return { matches: false };
    },
});
