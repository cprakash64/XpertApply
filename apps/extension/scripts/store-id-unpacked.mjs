// Usage: XA_STORE_PUBLIC_KEY="<base64 DER public key from the Dashboard>" node scripts/store-id-unpacked.mjs
// Copies the production build (dist/) to dist-store-id/ with `key` added so Chrome loads it as the Store item. Never touches the ZIP.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { verifiedStorePublicKey, STORE_EXTENSION_ID } from "../src/store-identity.mjs";

const key = verifiedStorePublicKey(process.env.XA_STORE_PUBLIC_KEY);
if (!existsSync("dist/manifest.json")) throw new Error("Run `npm run build` first.");
rmSync("dist-store-id", { recursive: true, force: true });
cpSync("dist", "dist-store-id", { recursive: true });
const manifest = JSON.parse(readFileSync("dist-store-id/manifest.json", "utf8"));
manifest.key = key;
writeFileSync("dist-store-id/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`dist-store-id/ ready; Chrome will report id ${STORE_EXTENSION_ID}. Unpacked acceptance only, never upload.`);
