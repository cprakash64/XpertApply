/**
 * The STAGING extension's identity.
 *
 * `STAGING_EXTENSION_PUBLIC_KEY` is a PUBLIC key. Putting it in the staging manifest's `key` field makes Chrome derive
 * the same extension id on every machine and folder, so the backend allowlist (EXTENSION_ALLOWED_IDS) can be set once.
 * It is not a signing credential: Chrome never needs the private half to load an unpacked extension, and the private
 * half of this pair was discarded at creation and exists nowhere. It must never be reused for production, whose id is
 * assigned by the Chrome Web Store and whose manifest carries no `key`.
 *
 * `STAGING_EXTENSION_ID` is DERIVED from the key by Chrome's published rule (first 128 bits of SHA-256 over the DER
 * public key, each hex digit mapped 0-f -> a-p). `extensionIdFromPublicKey` recomputes it, and a unit test pins the two
 * together. Whether Chrome itself reports this id for the built folder is verified by hand (see STAGING.md).
 */
import { createHash } from "node:crypto";

export const STAGING_EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArE+gIxQekODnho6tLHVw7cTobNKMQQYN2Ztq1FkZKykWjT51XDbWj4yuaWy2Eoix01p/LOIIMp7/KPGzfyBOD4vaRyEs7D32Cbz/qlSmO38dBYWsZDm5ZX4HocmQTSPQ21xTXASMWSt5dvJVwqyAOGIoIFgUm+G9SZzD2/jIFLOCNpFBQicmflU3wSenxTeLbQdXfxvVQ1dEKJ/vfawmHoctzgOW2P7KQoDSdlqxJuhLwlb/DHw/NXtBLf5YzTdZ9mJJWEMGjU8rDHaSU6sPYkEd0ejrJ8a6T5uk92AyFZpIlxdOKlfzqK+Tf13vUxiM6nwm9hz5fEnbwJBNGCLxRwIDAQAB";

export function extensionIdFromPublicKey(base64Der) {
  const digest = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest().subarray(0, 16);
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("");
}

export const STAGING_EXTENSION_ID = "cglmdonbfbadfbggkpajpkjgpekhkall";
