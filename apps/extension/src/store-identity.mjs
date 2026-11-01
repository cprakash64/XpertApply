/**
 * The Chrome Web Store item's identity, for UNPACKED acceptance builds only.
 *
 * The Store assigns the production id (documented in docs/release/chrome-web-store). The matching PUBLIC key is shown only in the
 * owner's Developer Dashboard (Package > View public key). It is public, not a credential, but the release ZIP must still carry no
 * `key`, so it is supplied at build time and used to make a separate unpacked copy that Chrome loads under the Store id.
 * Private signing keys are never involved and are never read.
 */
import { createHash } from "node:crypto";

export const STORE_EXTENSION_ID = "gnibjomjfdobadlockphjiibbpmiehcj";

export function extensionIdFromPublicKey(base64Der) {
  const digest = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("");
}

/** Returns the cleaned key, or throws unless it is a DER public key whose derived id is exactly the Store id. */
export function verifiedStorePublicKey(raw) {
  const key = String(raw ?? "").replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length < 200) {
    throw new Error("XA_STORE_PUBLIC_KEY must be the base64 DER public key from the Developer Dashboard (public key only).");
  }
  if (/PRIVATE/i.test(String(raw))) throw new Error("Refusing a private key.");
  const derived = extensionIdFromPublicKey(key);
  if (derived !== STORE_EXTENSION_ID) {
    throw new Error(`That key derives extension id ${derived}, not the Store id ${STORE_EXTENSION_ID}. Refusing to build.`);
  }
  return key;
}
