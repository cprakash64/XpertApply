# Permanent Store ID handoff and dependency map

Official known Store item ID: **`gnibjomjfdobadlockphjiibbpmiehcj`**. Canonical Dashboard-provided Store detail URL: **PENDING OWNER VERIFICATION**. Do not invent a URL slug or create another item. Synthetic test IDs and unpacked development IDs are not production routing identities.

Required future Web build-time values:

```text
NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj
NEXT_PUBLIC_CHROME_EXTENSION_URL=<OWNER-VERIFIED CANONICAL STORE DETAIL URL>
```

Current production observation from CWS-PREP-04: running container ID variable absent; positive ID wiring **NOT PROVEN**. URL **EMPTY** in observed running Web configuration/browser configuration. **WEB DEPLOY REQUIRED** under separate authorization; runtime-only environment edits cannot update compiled browser bundles. No deployment is performed here.

No extension manifest `key` or `update_url` is needed. No API hardcoded ID or API restart is required for ID routing alone. Existing first-party sender/auth fences remain in force; known routing ID does not bypass account authority.

## Dependency map for the known official item

| File/config | Current value and role | Store ID / URL needed? | Build/runtime and deployment impact |
| --- | --- | --- | --- |
| `.env.example` `NEXT_PUBLIC_CHROME_EXTENSION_ID` | Empty example slot | ID | Set real public ID in deployment config later; never a test/unpacked ID. |
| `.env.example` `NEXT_PUBLIC_CHROME_EXTENSION_URL` | Empty example slot | Store URL | Set a real Dashboard URL when available. |
| `apps/web/lib/siteConfig.ts` | Validates ID `[a-p]{32}` and official HTTPS Store URL | Both | Values are inlined into Web at **build time**; production Web image rebuild and web-only replacement required. |
| `apps/web/lib/extensionRuntime.ts`, `apps/web/lib/autoApply.ts` | Browser-routed Web-to-extension ping/session control | ID | Uses configured public ID; Web rebuild required, no API restart. |
| `apps/web/components/marketing/ExtensionCta.tsx`, `apps/web/components/AutoApplyModal.tsx` | Install CTA / unavailable fallback | Store URL | Real URL enables install navigation after Web rebuild; no extension rebuild. |
| `apps/web/Dockerfile`, `docker-compose.yml`, `compose.production.yml` | Pass `NEXT_PUBLIC_CHROME_EXTENSION_ID` and `NEXT_PUBLIC_CHROME_EXTENSION_URL` as Web build args and runtime env | Both | Rebuild Web with exact public values and replace Web only in a later authorized deployment. Runtime-only env changes cannot update an existing browser bundle. |
| `apps/extension/manifest.json` `externally_connectable` and `content_scripts` | Already restricted to apex and `www` XpertApply origins | Neither | No ID insertion or extension rebuild required for the assigned Store ID. |
| `apps/extension/src/security/externalMessaging.ts`, `src/background.ts` | Validates browser-attributed first-party sender origin/tab; no hardcoded Store ID | Neither | No extension rebuild for Store ID. |
| `apps/api/app/main.py` | CORS regex already accepts valid Chrome extension-origin ID shape; endpoint auth still uses session/launch tokens | Neither | No API code/config change or API restart required. |
| Web and extension tests / E2E | Synthetic or dynamically loaded IDs | Real ID only for later production handshake proof | Keep test values synthetic; add a later live handoff check against the real Store item. |
| Nginx / proxy | No Store ID reference found in repository configuration | Neither | No proxy change identified for ID handoff. |
| Release docs | Known official ID; canonical URL still pending | Known ID / verified URL when obtained | Record public ID and URL in release record without credentials. |

The Store item ID is **public routing metadata**, not a secret. Publisher account credentials, OAuth tokens, and signing private keys are secrets and must not be committed. No private signing key was created in this stage.
