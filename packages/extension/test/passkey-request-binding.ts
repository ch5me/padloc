import { expect } from "chai";
import { bindPasskeyRequest, isPasskeyRequestBindingCurrent } from "../src/passkey-request-binding";

suite("Passkey request binding", () => {
    test("binds a top-frame ceremony to the browser-reported origin and tab", () => {
        const binding = bindPasskeyRequest("https://accounts.google.com", {
            url: "https://accounts.google.com/signin/v2/challenge/pwd",
            frameId: 0,
            tab: { id: 42 },
        });
        expect(binding).to.deep.equal({ origin: "https://accounts.google.com", tabId: 42, frameId: 0 });
        expect(isPasskeyRequestBindingCurrent(binding!, { id: 42, url: "https://accounts.google.com/" })).to.equal(
            true
        );
    });

    test("rejects wrong frame, page-supplied origin mismatch, missing tab, and opaque origins", () => {
        expect(
            bindPasskeyRequest("https://accounts.google.com", {
                url: "https://accounts.google.com/",
                frameId: 1,
                tab: { id: 42 },
            })
        ).to.equal(null);
        expect(
            bindPasskeyRequest("https://accounts.google.com", {
                url: "https://evil.example/",
                frameId: 0,
                tab: { id: 42 },
            })
        ).to.equal(null);
        expect(
            bindPasskeyRequest("https://accounts.google.com", {
                url: "https://accounts.google.com/",
                frameId: 0,
            })
        ).to.equal(null);
        expect(bindPasskeyRequest("null", { url: "data:text/html,test", frameId: 0, tab: { id: 42 } })).to.equal(null);
    });

    test("fails closed when the tab identity or origin changes before signing", () => {
        const binding = bindPasskeyRequest("https://accounts.google.com", {
            url: "https://accounts.google.com/",
            frameId: 0,
            tab: { id: 42 },
        })!;
        expect(isPasskeyRequestBindingCurrent(binding, { id: 43, url: "https://accounts.google.com/" })).to.equal(
            false
        );
        expect(isPasskeyRequestBindingCurrent(binding, { id: 42, url: "https://myaccount.google.com/" })).to.equal(
            false
        );
        expect(isPasskeyRequestBindingCurrent(binding, { id: 42, url: "not a url" })).to.equal(false);
    });
});
