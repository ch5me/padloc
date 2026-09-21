import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLiveProcessEnvironment } from "./environment.js";

describe("isLiveProcessEnvironment", () => {
    it("treats HQ staging as live even when NODE_ENV is development", () => {
        assert.equal(
            isLiveProcessEnvironment({ HQ_ENVIRONMENT: "staging", NODE_ENV: "development" }),
            true
        );
    });

    it("treats NODE_ENV production as live", () => {
        assert.equal(isLiveProcessEnvironment({ NODE_ENV: "production" }), true);
    });

    it("stays closed for explicit local development", () => {
        assert.equal(isLiveProcessEnvironment({ HQ_ENVIRONMENT: "development", NODE_ENV: "development" }), false);
        assert.equal(isLiveProcessEnvironment({}), false);
    });
});
