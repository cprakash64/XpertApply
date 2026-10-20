/**
 * Stage 3C-V2 — read the extension's EFFECTIVE granted authority.
 *
 * The distinction this exists to make visible: `optional_host_permissions`
 * DECLARES the whole-web wildcard pattern, and a declaration grants nothing.
 * The only thing that matters for XA-06 is what `chrome.permissions.getAll()`
 * reports at runtime, which is what the user actually allowed.
 *
 * Reads only. Attaches to the throwaway test Chrome over the debugging port it
 * was launched with, evaluates `chrome.permissions.getAll()` inside the
 * extension's own service worker, and prints the result. It never grants,
 * revokes or modifies anything, and it touches no preference file.
 *
 * Chrome's own UI is the fallback if this cannot attach:
 *   chrome://extensions -> XpertApply -> Details -> Site access
 */
const PORT = process.env.XA_DEBUG_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  let targets;
  try {
    targets = await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    console.error(`
Could not reach Chrome's debugging port at ${BASE}.

  • Is the test Chrome still running?
  • Was it launched with --remote-debugging-port=${PORT}?

Fallback that always works, with no tooling at all:
  chrome://extensions  ->  XpertApply  ->  Details  ->  Site access
`);
    process.exit(1);
  }

  // The profile may run several extensions (Chrome for Testing ships a few of
  // its own). Identify XpertApply by asking each worker its own manifest name
  // rather than taking the first extension worker in the list — reading another
  // extension's permissions and reporting them as XpertApply's would be worse
  // than no evidence at all.
  const candidates = targets.filter(
    (t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"));
  let worker = null;
  for (const candidate of candidates) {
    const name = await evaluate(candidate.webSocketDebuggerUrl,
      "chrome.runtime.getManifest().name").catch(() => null);
    if (typeof name === "string" && name.includes("XpertApply")) { worker = candidate; break; }
  }
  if (!worker) {
    console.error(`
No XpertApply service worker is currently running.

MV3 workers idle out; that is normal and is not a failure. Wake it by
interacting with the extension (open the side panel, or reload the fixture
tab), then run this again.

Fallback: chrome://extensions -> XpertApply -> Details -> Site access
`);
    process.exit(1);
  }

  const result = await evaluate(worker.webSocketDebuggerUrl, `
    (async () => {
      const all = await chrome.permissions.getAll();
      const check = async (o) => chrome.permissions.contains({ origins: [o] }).catch(() => false);
      return JSON.stringify({
        grantedOrigins: (all.origins || []).sort(),
        apiPermissions: (all.permissions || []).sort(),
        wildcardGranted: (all.origins || []).includes("https://*/*"),
        employer: await check("https://careers.fixture-employer.test/*"),
        ats:      await check("https://boards.greenhouse.io/*"),
        ads:      await check("https://ads.doubleclick.net/*")
      }, null, 2);
    })()
  `);

  const data = JSON.parse(result);
  console.log(`
=== XPERTAPPLY EFFECTIVE PERMISSIONS (chrome.permissions.getAll) ===

GRANTED ORIGINS
${data.grantedOrigins.map((o) => "  " + o).join("\n") || "  (none)"}

API PERMISSIONS
${data.apiPermissions.map((p) => "  " + p).join("\n") || "  (none)"}

FIXTURE ORIGIN CHECKS
  employer  careers.fixture-employer.test : ${data.employer ? "GRANTED" : "not granted"}
  ATS       boards.greenhouse.io          : ${data.ats ? "GRANTED" : "not granted"}
  ads       ads.doubleclick.net           : ${data.ads ? "GRANTED" : "not granted"}

WILDCARD https://*/* GRANTED AT RUNTIME : ${data.wildcardGranted ? "YES  <-- FAILURE" : "NO"}

(Paste this whole block into the results template.)
`);
}

/** One CDP Runtime.evaluate over a raw WebSocket. No dependencies. */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true }
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      const value = message.result?.result?.value;
      if (message.result?.exceptionDetails || value === undefined) {
        return reject(new Error("evaluation failed in the service worker"));
      }
      resolve(value);
    });
    socket.addEventListener("error", () => reject(new Error("websocket error")));
  });
}

main().catch((err) => {
  console.error("Diagnostic failed:", err.message);
  console.error("Fallback: chrome://extensions -> XpertApply -> Details -> Site access");
  process.exit(1);
});
