export interface WorkerReadyResponse {
    type?: string;
}

export interface WorkerReadinessOptions {
    retryDelayMs?: number;
    maxWaitMs?: number;
}

export async function waitForWorkerReady(
    sendPing: () => Promise<WorkerReadyResponse | undefined>,
    { retryDelayMs = 100, maxWaitMs = 500 }: WorkerReadinessOptions = {}
): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const response = await Promise.race([
                sendPing(),
                new Promise<undefined>((resolve) => setTimeout(resolve, retryDelayMs)),
            ]);
            if (response?.type === "pong") return true;
        } catch {
            // The worker is still starting; retry inside the bounded window.
        }

        const remaining = maxWaitMs - (Date.now() - start);
        if (remaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remaining)));
        }
    }

    return false;
}
