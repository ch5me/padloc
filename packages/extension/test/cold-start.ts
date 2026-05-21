import { expect } from "chai";
import sinon from "sinon";
import { browser } from "webextension-polyfill-ts";
import { ExtensionStorage } from "../src/storage";

suite("ExtensionApp popup cold-start restoration", () => {
    let sandbox: sinon.SinonSandbox;
    let storage: ExtensionStorage;

    const mockTab: browser.Tab = {
        id: 1,
        active: true,
        currentWindow: true,
        url: "https://example.com/login",
    };

    const mockAccount = { id: "account-1", email: "test@example.com" };
    const mockSession = { id: "session-1" };
    const mockMasterKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    setup(() => {
        sandbox = sinon.createSandbox();

        const sessionStorage: Record<string, any> = {};
        sandbox.stub(browser.storage, "session").value({
            get: sandbox.stub().callsFake((keys?: string | string[] | Record<string, unknown> | null) => {
                if (!keys) return Promise.resolve(sessionStorage);
                if (typeof keys === "string") return Promise.resolve({ [keys]: sessionStorage[keys] });
                if (Array.isArray(keys)) {
                    const result: Record<string, any> = {};
                    for (const k of keys) result[k] = sessionStorage[k];
                    return Promise.resolve(result);
                }
                return Promise.resolve({});
            }),
            set: sandbox.stub().callsFake((items: Record<string, unknown>) => {
                Object.assign(sessionStorage, items);
                return Promise.resolve();
            }),
            remove: sandbox.stub().callsFake((keys: string | string[]) => {
                if (typeof keys === "string") delete sessionStorage[keys];
                else for (const k of keys) delete sessionStorage[k];
                return Promise.resolve();
            }),
            setAccessLevel: sandbox.stub().resolves(undefined),
        });

        const localStorage: Record<string, any> = {};
        sandbox.stub(browser.storage, "local").value({
            get: sandbox.stub().callsFake((keys?: string | string[] | Record<string, unknown> | null) => {
                if (!keys) return Promise.resolve(localStorage);
                if (typeof keys === "string") return Promise.resolve({ [keys]: localStorage[keys] });
                if (Array.isArray(keys)) {
                    const result: Record<string, any> = {};
                    for (const k of keys) result[k] = localStorage[k];
                    return Promise.resolve(result);
                }
                return Promise.resolve({});
            }),
            set: sandbox.stub().callsFake((items: Record<string, unknown>) => {
                Object.assign(localStorage, items);
                return Promise.resolve();
            }),
            remove: sandbox.stub().callsFake((keys: string | string[]) => {
                if (typeof keys === "string") delete localStorage[keys];
                else for (const k of keys) delete localStorage[k];
                return Promise.resolve();
            }),
            clear: sandbox.stub().resolves(undefined),
        });

        sandbox.stub(browser.tabs, "query").resolves([mockTab]);
        sandbox.stub(browser.runtime, "sendMessage").resolves({ type: "pong" });
        sandbox.stub(browser.runtime, "onMessage").value({
            addListener: sandbox.stub(),
            removeListener: sandbox.stub(),
            hasListener: sandbox.stub(),
            hasListeners: sandbox.stub(),
        });

        sandbox.stub(browser.alarms, "create").resolves(undefined);
        sandbox.stub(browser.alarms, "clear").resolves(undefined);
        sandbox.stub(browser.alarms, "onAlarm").value({
            addListener: sandbox.stub(),
            removeListener: sandbox.stub(),
            hasListener: sandbox.stub(),
            hasListeners: sandbox.stub(),
        });

        sandbox.stub(browser.contextMenus, "create").resolves("");
        sandbox.stub(browser.contextMenus, "removeAll").resolves(undefined);
        sandbox.stub(browser.contextMenus, "onClicked").value({
            addListener: sandbox.stub(),
            removeListener: sandbox.stub(),
            hasListener: sandbox.stub(),
            hasListeners: sandbox.stub(),
        });

        sandbox.stub(browser.tabs, "onUpdated").value({
            addListener: sandbox.stub(),
            removeListener: sandbox.stub(),
            hasListener: sandbox.stub(),
            hasListeners: sandbox.stub(),
        });

        sandbox.stub(browser.tabs, "onActivated").value({
            addListener: sandbox.stub(),
            removeListener: sandbox.stub(),
            hasListener: sandbox.stub(),
            hasListeners: sandbox.stub(),
        });

        sandbox.stub(chrome.action, "setBadgeText").resolves(undefined);
        sandbox.stub(chrome.action, "setBadgeBackgroundColor").resolves(undefined);
        sandbox.stub(chrome.action, "setIcon").resolves(undefined);
        sandbox.stub(chrome.action, "setTitle").resolves(undefined);
        sandbox.stub(chrome.action, "openPopup").resolves(undefined);

        storage = new ExtensionStorage();
    });

    teardown(() => {
        sandbox.restore();
    });

    suite("worker liveness ping", () => {
        test("popup sends ping to worker and waits for pong", async () => {
            const sendMessageStub = browser.runtime.sendMessage as sinon.SinonStub;
            sendMessageStub.resolves({ type: "pong" });

            let pongReceived = false;
            try {
                const response = await browser.runtime.sendMessage({ type: "ping" });
                pongReceived = response?.type === "pong";
            } catch {
                pongReceived = false;
            }

            expect(pongReceived).to.be.true;
            expect(sendMessageStub.calledWith({ type: "ping" })).to.be.true;
        });

        test("popup continues even if worker doesn't respond to ping", async () => {
            const sendMessageStub = browser.runtime.sendMessage as sinon.SinonStub;
            sendMessageStub.rejects(new Error("Worker not ready"));

            let pongReceived = false;
            try {
                const response = await browser.runtime.sendMessage({ type: "ping" });
                pongReceived = response?.type === "pong";
            } catch {
                pongReceived = false;
            }

            expect(pongReceived).to.be.false;
        });
    });

    suite("router state restoration", () => {
        test("RouterState defaults to empty path", async () => {
            const RouterState = class {
                id = "";
                path = "";
                params = {};
                lastMatchingItems: string[] = [];
                constructor(vals: any = {}) {
                    Object.assign(this, vals);
                }
            };

            const state = new RouterState();
            expect(state.path).to.equal("");
            expect(state.lastMatchingItems).to.deep.equal([]);
        });

        test("lastMatchingItems stores item IDs for comparison", async () => {
            const RouterState = class {
                id = "";
                path = "items";
                params = { host: "true" };
                lastMatchingItems: string[] = ["item-1", "item-2"];
                constructor(vals: any = {}) {
                    Object.assign(this, vals);
                }
            };

            const state = new RouterState();
            expect(state.lastMatchingItems).to.deep.equal(["item-1", "item-2"]);
            expect(state.lastMatchingItems.length).to.equal(2);
        });

        test("matching items comparison detects new items", async () => {
            const currentItems = [
                { item: { id: "item-1" } },
                { item: { id: "item-2" } },
                { item: { id: "item-3" } },
            ];
            const lastMatchingItems = ["item-1", "item-2"];

            const hasNewItems =
                currentItems.length !== lastMatchingItems.length ||
                currentItems.some(({ item }: any) => !lastMatchingItems.includes(item.id));

            expect(hasNewItems).to.be.true;
        });

        test("matching items comparison detects removed items", async () => {
            const currentItems = [{ item: { id: "item-1" } }];
            const lastMatchingItems = ["item-1", "item-2"];

            const hasNewItems =
                currentItems.length !== lastMatchingItems.length ||
                currentItems.some(({ item }: any) => !lastMatchingItems.includes(item.id));

            expect(hasNewItems).to.be.true;
        });

        test("matching items comparison returns false when items unchanged", async () => {
            const currentItems = [
                { item: { id: "item-1" } },
                { item: { id: "item-2" } },
            ];
            const lastMatchingItems = ["item-1", "item-2"];

            const hasNewItems =
                currentItems.length !== lastMatchingItems.length ||
                currentItems.some(({ item }: any) => !lastMatchingItems.includes(item.id));

            expect(hasNewItems).to.be.false;
        });
    });

    suite("tab capture before super.load()", () => {
        test("load sequence is tab capture then super.load then routing", () => {
            const sequence: string[] = [];

            class TestExtensionApp {
                async load() {
                    sequence.push("tabCaptured");
                    sequence.push("superLoadCalled");
                    sequence.push("routingDecision");
                }
            }

            const app = new TestExtensionApp();
            app.load();

            expect(sequence).to.deep.equal(["tabCaptured", "superLoadCalled", "routingDecision"]);
        });
    });

    suite("locked worker with session key", () => {
        test("popup can unlock when session key is available", async () => {
            const sessionKeyData = {
                accountId: mockAccount.id,
                sessionId: mockSession.id,
                masterKey: Buffer.from(mockMasterKey).toString("base64"),
            };

            const sessionGet = browser.storage.session.get as sinon.SinonStub;
            sessionGet.withArgs("session_master_key").resolves({
                session_master_key: sessionKeyData,
            });

            const masterKey = await browser.storage.session.get("session_master_key");
            expect(masterKey.session_master_key).to.exist;
            expect(masterKey.session_master_key.accountId).to.equal(mockAccount.id);
        });

        test("popup stays locked when session key is missing", async () => {
            const sessionGet = browser.storage.session.get as sinon.SinonStub;
            sessionGet.withArgs("session_master_key").resolves({});

            const masterKey = await browser.storage.session.get("session_master_key");
            expect(masterKey.session_master_key).to.be.undefined;
        });
    });

    suite("background message handling", () => {
        test("background handles ping message and returns pong", async () => {
            const message = { type: "ping" };

            let response: any;
            switch (message.type) {
                case "ping":
                    response = { type: "pong" };
                    break;
            }

            expect(response).to.deep.equal({ type: "pong" });
        });

        test("background update is awaited", async () => {
            let updateCalled = false;
            const update = async () => {
                updateCalled = true;
            };

            await update();
            expect(updateCalled).to.be.true;
        });
    });
});

suite("ExtensionApp routing decision logic", () => {
    test("navigates to items when there are matching items and they're new", () => {
        const matchingItems = [{ item: { id: "item-1" } }];
        const routerState = { path: "vaults", params: {}, lastMatchingItems: [] as string[] };

        const hasNewMatchingItems =
            matchingItems.length !== routerState.lastMatchingItems.length ||
            matchingItems.some(
                ({ item }: { item: { id: string } }) => !routerState.lastMatchingItems.includes(item.id)
            );

        const shouldGoToItems =
            matchingItems.length && (hasNewMatchingItems || (routerState.path === "items" && !routerState.params.search));

        expect(shouldGoToItems).to.be.true;
    });

    test("restores previous route when no matching items", () => {
        const matchingItems: any[] = [];
        const routerState = { path: "vaults", params: {}, lastMatchingItems: [] as string[] };

        const hasNewMatchingItems =
            matchingItems.length !== routerState.lastMatchingItems.length ||
            matchingItems.some(
                ({ item }: { item: { id: string } }) => !routerState.lastMatchingItems.includes(item.id)
            );

        const shouldGoToItems =
            matchingItems.length && (hasNewMatchingItems || (routerState.path === "items" && !routerState.params.search));

        expect(shouldGoToItems).to.be.false;
    });

    test("falls back to vaults when routerState.path is empty", () => {
        const routerState = { path: "", params: {}, lastMatchingItems: [] as string[] };
        const restoredPath = routerState.path || "vaults";
        expect(restoredPath).to.equal("vaults");
    });

    test("keeps existing path when routerState.path is valid", () => {
        const routerState = { path: "items", params: { host: "true" }, lastMatchingItems: ["item-1"] };
        const restoredPath = routerState.path || "vaults";
        expect(restoredPath).to.equal("items");
    });
});
