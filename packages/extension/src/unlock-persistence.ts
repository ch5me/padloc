export type UnlockPersistenceApp = {
    login(opts: {
        email: string;
        password: string;
        authToken?: string;
        addTrustedDevice?: boolean;
        asAdmin?: boolean;
    }): Promise<void>;
    unlock(password: string): Promise<void>;
    unlockWithMasterKey(key: Uint8Array): Promise<void>;
};

export async function awaitWorkerUnlock(
    notify: () => Promise<unknown>
): Promise<void> {
    const response = await notify();
    if (
        !response ||
        typeof response !== "object" ||
        (response as { type?: unknown }).type !== "unlockedAck" ||
        (response as { unlocked?: unknown }).unlocked !== true
    ) {
        throw new Error("The extension worker did not acknowledge the unlocked session");
    }
}

export function installUnlockPersistenceHooks(
    app: UnlockPersistenceApp,
    persistUnlockedState: (reason: "login" | "password" | "session") => Promise<void>
) {
    const originalLogin = app.login.bind(app);
    app.login = async (opts) => {
        await originalLogin(opts);
        await persistUnlockedState("login");
    };

    const originalUnlock = app.unlock.bind(app);
    app.unlock = async (password: string) => {
        await originalUnlock(password);
        await persistUnlockedState("password");
    };

    const originalUnlockWithMasterKey = app.unlockWithMasterKey.bind(app);
    app.unlockWithMasterKey = async (key: Uint8Array) => {
        await originalUnlockWithMasterKey(key);
        await persistUnlockedState("session");
    };
}
