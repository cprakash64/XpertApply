import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module
import { STORE_EXTENSION_ID, extensionIdFromPublicKey, verifiedStorePublicKey } from "../store-identity.mjs";

const der = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("Store identity guard", () => {
  it("is a 32-character a-p id", () => {
    expect(STORE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });
  it("derives ids by Chrome's rule", () => {
    expect(extensionIdFromPublicKey(der())).toMatch(/^[a-p]{32}$/);
  });
  it("refuses a key that does not derive the Store id (e.g. the staging or any other key)", () => {
    expect(() => verifiedStorePublicKey(der())).toThrow(/not the Store id/);
  });
  it("refuses private keys and junk", () => {
    expect(() => verifiedStorePublicKey("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toThrow();
    expect(() => verifiedStorePublicKey("")).toThrow();
  });
});
