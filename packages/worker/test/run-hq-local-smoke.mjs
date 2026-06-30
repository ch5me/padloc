import http from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("ts-node/register/transpile-only");
const {
    flushHqInstrumentation,
    hqInstrumentationStatus,
    initializeHqInstrumentation,
    resetHqInstrumentationForTests,
    startHqSpan,
} = require("../src/hq-instrumentation.ts");

const port = Number(process.env.HQ_FAKE_ENDPOINT_PORT || 18793);
const posts = [];
const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        posts.push({ method: req.method, url: req.url, body, contentType: req.headers["content-type"] || "" });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
});

await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
});

try {
    resetHqInstrumentationForTests();
    initializeHqInstrumentation({
        sentryDsn: `http://127.0.0.1:${port}/321`,
        otlpEndpoint: `http://127.0.0.1:${port}/otlp`,
        allowLocalEndpoints: true,
    });
    const span = startHqSpan("padloc.worker.local_smoke", { attributes: { smoke: true } });
    span.end({ status: "ok" });
    await flushHqInstrumentation();

    const tracePost = posts.find((post) => post.url === "/otlp/v1/traces");
    const envelopePost = posts.find((post) => post.url === "/api/321/envelope/");
    const ok = hqInstrumentationStatus() === "ready" && !!tracePost;

    console.log([
        "=== HQ Local Smoke ===",
        `Status: ${hqInstrumentationStatus()}`,
        `Posts: ${posts.length}`,
        `Envelope: ${envelopePost ? "yes" : "no"}`,
        `Trace: ${tracePost ? "yes" : "no"}`,
    ].join("\n"));

    process.exitCode = ok ? 0 : 1;
} finally {
    server.close();
}
