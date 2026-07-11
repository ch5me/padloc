require("ts-node/register");
const http = require("http");
const { createHash } = require("crypto");
const { ChallengeStore } = require("./challenge-store.ts");
const { verifyAssertion, verifyRegistration } = require("./shared-verifier.ts");

const decode = (value) => Buffer.from(value, "base64url");
const encode = (value) => Buffer.from(value).toString("base64url");

function json(response, status, value) {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
}

function createRpServer(options = {}) {
const host = options.host || "127.0.0.1";
const port = Number(options.port ?? process.env.PADLOC_RP_PORT ?? 4173);
const origin = options.origin || `http://localhost:${port}`;
const rpID = options.rpID || "localhost";
const challenges = new ChallengeStore(options.challengeTtlMs ?? 300_000);
let credential = null;
const status = { registrationVerified: false, assertionCount: 0, credentialFingerprint: null };
const server = http.createServer((request, response) => {
    if (request.method === "GET" && (request.url === "/" || request.url.startsWith("/?"))) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(page);
        return;
    }
    if (request.method === "GET" && request.url === "/status") {
        json(response, 200, status);
        return;
    }
    if (request.method === "POST" && (request.url === "/options/register" || request.url === "/options/assert")) {
        const kind = request.url.endsWith("register") ? "registration" : "assertion";
        const issued = challenges.issue(kind);
        json(response, 200, { ceremony: issued.id, challenge: encode(issued.challenge), origin, rpID, credentialID: credential?.id });
        return;
    }
    if (request.method === "POST" && (request.url === "/verify/register" || request.url === "/verify/assert")) {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (request.url.endsWith("register")) {
                    const issued = challenges.consume(body.ceremony, "registration");
                    const id = decode(body.credentialID);
                    const verified = verifyRegistration({
                        clientDataJSON: decode(body.clientDataJSON), attestationObject: decode(body.attestationObject),
                        credentialID: id, expectedChallenge: issued.challenge, expectedOrigin: origin,
                        expectedRpID: rpID, requireUV: true, requireBackupEligible: true, requireBackupState: true,
                    });
                    credential = { id: encode(id), publicKeyJwk: verified.publicKeyJwk };
                    status.registrationVerified = true;
                    status.credentialFingerprint = createHash("sha256").update(id).digest("hex").slice(0, 16);
                } else {
                    const issued = challenges.consume(body.ceremony, "assertion");
                    if (!credential) throw new Error("credential not registered");
                    verifyAssertion({
                        clientDataJSON: decode(body.clientDataJSON), authenticatorData: decode(body.authenticatorData),
                        signature: decode(body.signature), credentialID: decode(body.credentialID),
                        expectedCredentialID: decode(credential.id), publicKeyJwk: credential.publicKeyJwk,
                        expectedChallenge: issued.challenge, expectedOrigin: origin, expectedRpID: rpID,
                        requireUV: true, requireBackupEligible: true, requireBackupState: true,
                    });
                    status.assertionCount += 1;
                }
                json(response, 200, { ok: true });
            } catch (error) {
                json(response, 400, { ok: false, category: "verification-rejected" });
            }
        });
        return;
    }
    json(response, 404, { ok: false });
});
return { server, host, port, origin, rpID };
}

const page = `<!doctype html><meta charset="utf-8"><title>CH5 Controlled Passkey RP</title>
<style>body{font:16px system-ui;max-width:720px;margin:60px auto;padding:20px}button{font:inherit;padding:10px 16px;margin-right:8px}#status{margin-top:20px}</style>
<h1>CH5 Controlled Passkey RP</h1><p>Native provider conformance lane. The server retains public credential data only.</p>
<button id="register">Register</button><button id="authenticate">Authenticate</button><div id="status">Ready</div>
<script>
const b=v=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(v.length/4)*4,'=')),c=>c.charCodeAt(0));
const e=v=>btoa(String.fromCharCode(...new Uint8Array(v))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const post=(u,v={})=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(v)}).then(r=>r.json());
const statusNode=document.getElementById('status');
document.getElementById('register').onclick=async()=>{try{statusNode.textContent='Registering…';const o=await post('/options/register');const c=await navigator.credentials.create({publicKey:{challenge:b(o.challenge),rp:{id:o.rpID,name:'CH5 Controlled RP'},user:{id:b('AQIDBA'),name:'native-test',displayName:'Native Test'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:300000,attestation:'none'}});const r=await post('/verify/register',{ceremony:o.ceremony,credentialID:e(c.rawId),clientDataJSON:e(c.response.clientDataJSON),attestationObject:e(c.response.attestationObject)});statusNode.textContent=r.ok?'Registration verified':'Registration rejected';if(r.ok&&phase==='register')setTimeout(()=>document.getElementById('authenticate').click(),250);}catch(error){statusNode.textContent='Registration failed ('+(error?.name||'UnknownError')+')';}};
document.getElementById('authenticate').onclick=async()=>{try{statusNode.textContent='Authenticating…';const o=await post('/options/assert');if(!o.credentialID)throw new DOMException('No registered credential','InvalidStateError');const c=await navigator.credentials.get({publicKey:{challenge:b(o.challenge),rpId:o.rpID,allowCredentials:[{type:'public-key',id:b(o.credentialID)}],userVerification:'required',timeout:300000}});const r=await post('/verify/assert',{ceremony:o.ceremony,credentialID:e(c.rawId),clientDataJSON:e(c.response.clientDataJSON),authenticatorData:e(c.response.authenticatorData),signature:e(c.response.signature)});statusNode.textContent=r.ok?'Authentication verified':'Authentication rejected';}catch(error){statusNode.textContent='Authentication failed ('+(error?.name||'UnknownError')+')';}};
const phase=new URLSearchParams(location.search).get('native-system');
if(phase==='register')setTimeout(()=>document.getElementById('register').click(),250);
if(phase==='assert')setTimeout(()=>document.getElementById('authenticate').click(),250);
</script>`;

module.exports = { createRpServer };

if (require.main === module) {
    const instance = createRpServer();
    instance.server.listen(instance.port, instance.host, () =>
        console.log(`CH5 controlled RP ready at ${instance.origin}`)
    );
}
