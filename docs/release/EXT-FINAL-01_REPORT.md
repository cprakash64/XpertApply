# EXT-FINAL-01: extension launch completion

Status: local commit `8665fbe` on `release/ext-final-01` (parent `32a7d54`). Nothing pushed, deployed, published or submitted. No API, migration, Networking or Hunter change.

## Artifact
| | |
|---|---|
| Source commit | `8665fbecfa1ff49cbacf76aa845b95888afaa34c`, tree `ad340b1ee8fc3f37e5d29412517d0656f1bf1fef` |
| `apps/extension` subtree | `f2bf9357ed9a5e5888012e0e2427e52182ae6492` (byte-identical to `212aee3:apps/extension`) |
| `apps/web` subtree | `f9d3b0d1b5555416534bb01790503d990ed07d00` |
| Release ZIP | `apps/extension/xpertapply-extension.zip` (copy: `~/Developer/XpertApply-builds/xpertapply-extension-ext-final-01-8665fbe.zip`), 283,322 bytes |
| ZIP SHA-256 | `18b98e1c690d8c3c41258694039008b106254887893b2836fea420c7012f279d` |
| Build id | `0.3.0 (8665fbe 2026-11-01T07:09:19.408Z; production)`; the ZIP embeds its build time, so verify by the hash above, not by rebuilding |
| Manifest | MV3, 0.3.0, no `key`; permissions `activeTab, identity, sidePanel, storage, scripting, tabs`; host permissions only `api.xpertapply.com`, `xpertapply.com`, `www.xpertapply.com`; `https://*/*` is optional and requested per origin; no `.map` files, no staging host, no credential material |

## What changed
1. `apps/extension` replaced by the 212aee3 line (0.2.0 on this branch had a wildcard `https://*/*` host permission and all-frames content script).
2. `apps/web`: the part of `1fd837c` the premium line lacked (`lib/extensionRuntime.ts`, `lib/authSession.ts`, `lib/autoApply.ts`, test). Website sign-out or account change now asks the installed extension to purge the prior account's workflow state. Found by `xa12-account-replacement` failing deterministically in a real browser (the page sent a ping but never `XPERTAPPLY_EXTERNAL_SESSION_END`).

## Chrome Web Store checklist
| Item | State |
|---|---|
| Package | ZIP above, manifest at root |
| Single purpose | Fill the user's own job applications from their XpertApply profile; the user reviews and submits |
| `activeTab` | Toolbar click on a supported page (first-use disclosure before any page read) |
| `tabs` | Match the open tab URL to a supported application page and bind the workflow to that tab |
| `scripting` | Inject the assistant into a page only after the user granted that exact origin or clicked the toolbar |
| `storage` | Session handoffs, tab bindings, settings; credential is in IndexedDB, never `chrome.storage.local` |
| `sidePanel` | The assistant panel |
| `identity` | `launchWebAuthFlow` for the XpertApply connect consent page only |
| Optional host `https://*/*` | Requested one exact origin at a time, from a user gesture |
| Remote code | None (no eval, no remote script) |
| Data use | Profile and documents fetched from api.xpertapply.com for the connected account; nothing sold; no analytics |
| Privacy policy | https://xpertapply.com/privacy (200; names the extension, tab and navigation use, storage) |
| Support URL | **BLOCKER**: https://xpertapply.com/support is 404 |
| Terms | https://xpertapply.com/terms is 404 (not required by the Store, but linked from earlier worksheets) |
| Screenshots | Not produced here (need a connected real account); capture from the acceptance steps below |

## Remaining launch steps (not done here)
1. Publish the Store item to learn the production extension ID (none is recorded anywhere; unpacked builds derive a path-based ID).
2. Production API: set `EXTENSION_ALLOWED_IDS=["<store id>"]` and recreate only the API container. This is the smallest necessary guarded release; without it Connect is refused with 400 for every real user.
3. Production web: build with `NEXT_PUBLIC_CHROME_EXTENSION_ID=<store id>` and `NEXT_PUBLIC_CHROME_EXTENSION_URL` so the site routes to the extension; include this commit's `apps/web` change.
4. Add `/support` (and `/terms`) to the website.
5. Founder desktop-Chrome run of EXT-E2 C1 to C14 against production with a real account.
