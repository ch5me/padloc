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

export function installUnlockPersistenceHooks(app: UnlockPersistenceApp, persistUnlockedState: () => Promise<void>) {
    const originalLogin = app.login.bind(app);
    app.login = async (opts) => {
        await originalLogin(opts);
        await persistUnlockedState();
    };

    const originalUnlock = app.unlock.bind(app);
    app.unlock = async (password: string) => {
        await originalUnlock(password);
        await persistUnlockedState();
    };

    const originalUnlockWithMasterKey = app.unlockWithMasterKey.bind(app);
    app.unlockWithMasterKey = async (key: Uint8Array) => {
        await originalUnlockWithMasterKey(key);
        await persistUnlockedState();
    };
}
