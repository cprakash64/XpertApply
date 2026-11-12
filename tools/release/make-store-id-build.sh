#!/bin/bash
# Builds the production-ID UNPACKED acceptance folder from the exact candidate ZIP.
# Reads the Store PUBLIC key from the clipboard (Dashboard > Package > View public key). Never prints or stores it
# anywhere except inside the unpacked folder's manifest.json. Never upload that folder.
set -euo pipefail
# Canonical checkout: tools/release/ lives inside it. Override with XA_REPO_ROOT / XA_ARTIFACTS if needed.
ROOT="${XA_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
B="${XA_ARTIFACTS:-$ROOT/local-artifacts/releases/extension-zips}"
REPO="$ROOT/apps/extension"
# Historical pin (unchanged default). A different candidate requires BOTH --zip and --sha256 (full 64-hex); nothing is inferred.
ZIP=$B/xpertapply-extension-0.3.1-44c107e.zip
WANT=9dec55f058ecaf7c2b45176c8c7dbba24f7f4915691e926170f6592c21255b3a
W=$B/xpertapply-0.3.1-44c107e-store-id-work
ARG_ZIP=""; ARG_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ARG_ZIP="${2:-}"; shift 2;;
    --sha256) ARG_SHA="${2:-}"; shift 2;;
    *) echo "unknown argument: $1 (usage: $0 [--zip PATH --sha256 HEX])"; exit 2;;
  esac
done
if [ -n "$ARG_ZIP" ] || [ -n "$ARG_SHA" ]; then
  [ -n "$ARG_ZIP" ] && [ -n "$ARG_SHA" ] || { echo "--zip and --sha256 must be given together."; exit 2; }
  [ -f "$ARG_ZIP" ] || { echo "candidate ZIP not found: $ARG_ZIP"; exit 2; }
  case "$ARG_ZIP" in /*) ;; *) echo "--zip must be an absolute path."; exit 2;; esac
  echo "$ARG_SHA" | grep -Eq '^[0-9a-f]{64}$' || { echo "--sha256 must be 64 lowercase hex characters."; exit 2; }
  ZIP="$ARG_ZIP"; WANT="$ARG_SHA"
  W="$B/store-id-work-$(basename "$ZIP" .zip)"
fi
echo "candidate: $ZIP"

[ "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)" = "$WANT" ] || { echo "ZIP checksum mismatch; stopping."; exit 1; }
rm -rf "$W"; mkdir -p "$W/dist"; unzip -q "$ZIP" -d "$W/dist"
cd "$W"
XA_STORE_PUBLIC_KEY="$(pbpaste)" node "$REPO/scripts/store-id-unpacked.mjs" 2>&1 | sed -E 's/[A-Za-z0-9+\/=]{60,}/[redacted]/g' | grep -E "ready|Error:" || true
[ -f "$W/dist-store-id/manifest.json" ] || { echo "No folder produced: the clipboard did not hold the Store public key. Copy it again and re-run."; exit 1; }

# Only manifest.key may differ from the ZIP contents.
diff -rq "$W/dist" "$W/dist-store-id" | grep -v "manifest.json" && { echo "UNEXPECTED file differences"; exit 1; } || true
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { extensionIdFromPublicKey, STORE_EXTENSION_ID } from "'"$REPO"'/src/store-identity.mjs";
const a = JSON.parse(readFileSync("'"$W"'/dist/manifest.json", "utf8"));
const b = JSON.parse(readFileSync("'"$W"'/dist-store-id/manifest.json", "utf8"));
const { key, ...rest } = b;
const same = JSON.stringify(rest) === JSON.stringify(a);
const id = extensionIdFromPublicKey(key);
console.log("manifest identical except key:", same);
console.log("derived extension id:", id, id === STORE_EXTENSION_ID ? "(matches production)" : "(MISMATCH)");
console.log("version:", b.version);
if (!same || id !== STORE_EXTENSION_ID) process.exit(1);
'
echo "Load unpacked folder: $W/dist-store-id"
