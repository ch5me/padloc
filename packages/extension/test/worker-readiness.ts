import { expect } from "chai";
import { waitForWorkerReady } from "../src/worker-readiness";

suite("Extension worker readiness", () => {
    test("returns immediately when the worker answers", async () => {
        const ready = await waitForWorkerReady(async () => ({ type: "pong" }), {
            retryDelayMs: 5,
            maxWaitMs: 30,
        });

        expect(ready).to.be.true;
    });

    test("bounds a sendMessage call that never settles", async () => {
        const start = Date.now();
        const ready = await waitForWorkerReady(() => new Promise(() => {}), {
            retryDelayMs: 5,
            maxWaitMs: 30,
        });

        expect(ready).to.be.false;
        expect(Date.now() - start).to.be.lessThan(150);
    });
});
