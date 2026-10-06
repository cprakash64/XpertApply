# Permanent Store ID handoff and dependency map

Official known Store item ID: **`gnibjomjfdobadlockphjiibbpmiehcj`**. Owner-proven Dashboard lifecycle: **Draft / unpublished**. Public canonical Store detail URL: **NOT YET AVAILABLE / NOT PROVEN; pending Store delivery/publication lifecycle**. Do not invent a URL slug or create another item. Synthetic test IDs and unpacked development IDs are not production routing identities.

Required future Web build-time values:

```text
NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj
NEXT_PUBLIC_CHROME_EXTENSION_URL=
# Keep unset until an authoritative usable official Store URL exists.
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


## CWS-PREP-06R — owner-proven draft lifecycle and generic routing preparation

Authoritative owner Dashboard evidence: **XpertApply — Assisted Apply**, item `gnibjomjfdobadlockphjiibbpmiehcj`, **Draft**, uploaded package **0.2.0** (`ac64ea9 2026-09-19T20:51:04.476Z; production`), **not published**. Public canonical Store URL: **NOT YET AVAILABLE / NOT PROVEN; pending Store delivery/publication lifecycle**. Source preparation does not require that public URL now. The `empty-title` probe is not a listing URL and must not be configured.

Observed draft fields: category Workflow & Planning; English; 128×128 icon present; no screenshots, small promo or marquee uploaded (marquee remains optional/deferred); Official URL field None; homepage https://xpertapply.com/; support URL empty; mature content OFF; payment Free of charge; visibility selection Public; All regions selected. Public selection is not publication. Submit for review is disabled; reason **UNKNOWN**, because “Why can't I submit?” was not inspected. These are observed draft settings, not owner confirmation of final distribution choices or completed release gates.

Future build-time routing: `NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj`; `NEXT_PUBLIC_CHROME_EXTENSION_URL` **MUST REMAIN UNSET** until an authoritative usable official Store URL exists. Production deployment remains PENDING. ID_ONLY_WEB_DEPLOYMENT: **REQUIRED_BEFORE_PRIVATE_STORE_HANDOFF** for actual production handshake qualification: browser-routed ping and account teardown require the explicit ID, while install CTA can safely stay unavailable and AutoApply falls back to documentation. This is not a prerequisite for merely drafting/reviewing the Store item. Next.js public values require a Web image rebuild; future deployment is Web-only, no API restart or extension rebuild for ID routing alone. No deployment here.

Current-source mismatch evidence: prior `chromeExtensionUrl()` accepted an official-host non-root URL independently of `chromeExtensionId()`. ID A / URL B was accepted. Generic preparation now requires an HTTPS current Store detail route ending in an exact 32-character a–p identifier; when ID is also configured, the URL identifier must equal it. Harmless slug/query/fragment do not define identity. Malformed/ambiguous paths, encoded identifiers/traversal, wrong host, root and mismatched pairs produce no install URL. Runtime routing still uses only the independently validated explicit ID; no URL-derived routing, network validation or hardcoded product ID. ID-only remains valid during draft lifecycle. Targeted qualification results are recorded in the external stage report.

SIGNED_N_BASELINE: **NOT ESTABLISHED**. Neither the local historical ZIP nor the Dashboard upload is Store-delivered signed N. Later separately authorized same-item Private/trusted-tester review/delivery must establish whether signed 0.2.0 N is feasible before 0.3.0 replaces it. Final 0.3.0 ZIP remains NOT BUILT; NEW-04 OPEN/P1, PROXY-01 OPEN, assets/manual acceptance/final Dashboard reconciliation remain pending. No push, production action, Store mutation, upload, review submission or publication in this stage.
