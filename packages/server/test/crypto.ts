import { test, suite } from "mocha";
import { assert } from "chai";
import { cryptoProviderSpec } from "@elf-vault/core/src/spec/crypto";
import { NodeCryptoProvider } from "../src/crypto/node";

const spec = cryptoProviderSpec(new NodeCryptoProvider());

suite("NodeCryptoProvider", () => {
    spec(test, assert);
});
