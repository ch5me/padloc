import { Server } from "@elf-vault/core/src/server";
import { ServerConfig } from "@elf-vault/core/src/server";
import { Storage } from "@elf-vault/core/src/storage";
import { Logger, VoidLogger } from "@elf-vault/core/src/logging";
import { AuthServer } from "@elf-vault/core/src/auth";
import { EmailAuthServer } from "@elf-vault/core/src/auth/email";
import { TotpAuthConfig, TotpAuthServer } from "@elf-vault/core/src/auth/totp";
import { AttachmentStorage } from "@elf-vault/core/src/attachment";
import { Messenger } from "@elf-vault/core/src/messenger";
import { ChangeLogger } from "@elf-vault/core/src/logging";
import { RequestLogger } from "@elf-vault/core/src/logging";
import { ChangeLoggerConfig } from "@elf-vault/core/src/logging";
import { RequestLoggerConfig } from "@elf-vault/core/src/logging";
import { setPlatform } from "@elf-vault/core/src/platform";
import { D1Storage } from "./storage/d1";
import { OrgAwareProvisioner } from "./provisioner/org-aware";
import { R2AttachmentStorage } from "./attachments/r2";
import { ResendMessenger, MockMessenger } from "./email/resend";
import { WorkerPlatform } from "./platform";
import { Env, isLiveEnvironment } from "./env";

export function createServer(env: Env): Server {
    setPlatform(new WorkerPlatform());

    if (isLiveEnvironment(env.HQ_ENVIRONMENT)) {
        if (!env.DB) {
            throw new Error("DB binding is required when HQ_ENVIRONMENT is staging, production, or preview");
        }
        if (!env.ATTACHMENTS) {
            throw new Error("ATTACHMENTS binding is required when HQ_ENVIRONMENT is staging, production, or preview");
        }
        if (!env.HINTS) {
            throw new Error("HINTS binding is required when HQ_ENVIRONMENT is staging, production, or preview");
        }
    }

    const messenger: Messenger = createMessenger(env);
    const storage: Storage = env.DB ? new D1Storage(env.DB) : createStubStorage();
    const logger: Logger = new VoidLogger(undefined, { writeToConsole: isLiveEnvironment(env.HQ_ENVIRONMENT) });
    const authServers: AuthServer[] = [new EmailAuthServer(messenger), new TotpAuthServer(new TotpAuthConfig())];
    const attachmentStorage: AttachmentStorage = createAttachmentStorage(env);
    const changeLoggerConfig = new ChangeLoggerConfig();
    changeLoggerConfig.enabled = true;
    const requestLoggerConfig = new RequestLoggerConfig();
    requestLoggerConfig.enabled = true;
    const changeLogger = new ChangeLogger(storage, changeLoggerConfig);
    const requestLogger = new RequestLogger(storage, requestLoggerConfig);

    const config = new ServerConfig();
    config.verifyEmailOnSignup = env.EMAIL_VERIFY_ON_SIGNUP !== "false";
    config.environment = env.HQ_ENVIRONMENT || "development";
    config.allowDisableMFA = !isLiveEnvironment(env.HQ_ENVIRONMENT) && env.ALLOW_DISABLE_MFA === "true";
    if (env.CLIENT_URL) {
        config.clientUrl = env.CLIENT_URL;
    } else {
        const configuredOrigins = env.ALLOWED_ORIGINS || env.ALLOW_ORIGIN;
        const clientUrl = configuredOrigins
            ?.split(/[,\n]/)
            .map((origin) => origin.trim())
            .find((origin) => origin && origin !== "*");
        if (clientUrl) {
            config.clientUrl = clientUrl;
        }
    }

    return new Server(
        config,
        storage,
        messenger,
        logger,
        authServers,
        attachmentStorage,
        new OrgAwareProvisioner(storage),
        changeLogger,
        requestLogger
    );
}

/** Shared mock messenger — persists across requests for testability. */
let sharedMockMessenger: MockMessenger | null = null;

export function getSharedMockMessenger(): MockMessenger | null {
    return sharedMockMessenger;
}

export function createMessenger(env: Env): Messenger {
    const mockRequested = (env.EMAIL_BACKEND || "").trim().toLowerCase() === "mock";
    const hasResendApiKey = Boolean(env.RESEND_API_KEY);
    const hasEmailFromAddress = Boolean(env.EMAIL_FROM_ADDRESS);
    const backend = mockRequested ? "mock" : "resend";

    console.log("[createMessenger]", {
        backend,
        hasResendApiKey,
        hasEmailFromAddress,
        hqEnvironment: env.HQ_ENVIRONMENT ?? null,
    });

    if (isLiveEnvironment(env.HQ_ENVIRONMENT) && mockRequested) {
        throw new Error("EMAIL_BACKEND=mock is not allowed when HQ_ENVIRONMENT is staging, production, or preview");
    }

    if (mockRequested) {
        if (!sharedMockMessenger) {
            sharedMockMessenger = new MockMessenger();
        }
        return sharedMockMessenger;
    }

    if (!hasResendApiKey) {
        throw new Error("RESEND_API_KEY is required when EMAIL_BACKEND is not mock");
    }
    if (!hasEmailFromAddress) {
        throw new Error("EMAIL_FROM_ADDRESS is required when EMAIL_BACKEND is not mock");
    }

    return new ResendMessenger(env.RESEND_API_KEY as string, env.EMAIL_FROM_ADDRESS as string);
}

function createAttachmentStorage(env: Env): AttachmentStorage {
    if (env.ATTACHMENTS && env.DB) {
        return new R2AttachmentStorage({ bucket: env.ATTACHMENTS, db: env.DB });
    }
    if (isLiveEnvironment(env.HQ_ENVIRONMENT)) {
        throw new Error("ATTACHMENTS and DB bindings are required when HQ_ENVIRONMENT is staging, production, or preview");
    }
    return createStubAttachmentStorage();
}

function createStubStorage(): Storage {
    return {
        get: async () => {
            throw new Error("stub storage: get not implemented");
        },
        save: async () => {},
        delete: async () => {},
        clear: async () => {},
        list: async () => [],
    } as unknown as Storage;
}

function createStubAttachmentStorage(): AttachmentStorage {
    return {
        upload: async () => {
            throw new Error("stub attachment storage: upload not implemented");
        },
        delete: async () => {},
        getUrl: async () => "",
        getSignedUrl: async () => "",
    } as unknown as AttachmentStorage;
}
