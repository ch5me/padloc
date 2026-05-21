import { expect } from "chai";
import * as sinon from "sinon";
import { installUnlockPersistenceHooks } from "../src/unlock-persistence";

suite("Extension unlock session persistence", () => {
    test("password unlock awaits session persistence before resolving", async () => {
        const callOrder: string[] = [];
        let releasePersist!: () => void;

        const app = {
            login: async (_opts: { email: string; password: string }) => {
                callOrder.push("login");
            },
            unlock: async (_password: string) => {
                callOrder.push("unlock");
            },
            unlockWithMasterKey: async (_key: Uint8Array) => {
                callOrder.push("unlockWithMasterKey");
            },
        };

        const persist = sinon.stub().callsFake(
            () =>
                new Promise<void>((resolve) => {
                    callOrder.push("persist:start");
                    releasePersist = () => {
                        callOrder.push("persist:end");
                        resolve();
                    };
                })
        );

        installUnlockPersistenceHooks(app, persist);

        const unlockPromise = app.unlock("secret");
        await Promise.resolve();

        expect(callOrder).to.deep.equal(["unlock", "persist:start"]);

        let resolved = false;
        unlockPromise.then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).to.equal(false);

        releasePersist();
        await unlockPromise;

        expect(resolved).to.equal(true);
        expect(callOrder).to.deep.equal(["unlock", "persist:start", "persist:end"]);
    });

    test("master-key unlock also awaits session persistence", async () => {
        const persist = sinon.stub().resolves();
        const unlockWithMasterKey = sinon.stub().resolves();

        const app = {
            login: sinon.stub().resolves(),
            unlock: sinon.stub().resolves(),
            unlockWithMasterKey,
        };

        installUnlockPersistenceHooks(app, persist);

        const key = new Uint8Array([1, 2, 3]);
        await app.unlockWithMasterKey(key);

        expect(unlockWithMasterKey.calledOnceWithExactly(key)).to.equal(true);
        expect(persist.calledOnce).to.equal(true);
    });

    test("login also awaits session persistence", async () => {
        const callOrder: string[] = [];
        let releasePersist!: () => void;

        const app = {
            login: async (_opts: { email: string; password: string }) => {
                callOrder.push("login");
            },
            unlock: sinon.stub().resolves(),
            unlockWithMasterKey: sinon.stub().resolves(),
        };

        const persist = sinon.stub().callsFake(
            () =>
                new Promise<void>((resolve) => {
                    callOrder.push("persist:start");
                    releasePersist = () => {
                        callOrder.push("persist:end");
                        resolve();
                    };
                })
        );

        installUnlockPersistenceHooks(app, persist);

        const loginPromise = app.login({ email: "user@example.com", password: "secret" });
        await Promise.resolve();

        expect(callOrder).to.deep.equal(["login", "persist:start"]);

        let resolved = false;
        loginPromise.then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(resolved).to.equal(false);

        releasePersist();
        await loginPromise;

        expect(resolved).to.equal(true);
        expect(callOrder).to.deep.equal(["login", "persist:start", "persist:end"]);
    });
});
