/**
 * Stage 3C-V2 — the local world the manual acceptance test runs in.
 *
 * Everything the extension talks to lives on this one server, reached through
 * Chrome's own `--host-resolver-rules`. Nothing leaves the machine, no employer
 * is contacted, `/etc/hosts` is untouched and no sudo is involved.
 *
 * Five origins, all 127.0.0.1:
 *
 *   https://xpertapply.com                  first-party bridge — the REAL launch path
 *   https://api.xpertapply.com              session package, answers, résumé
 *   https://careers.fixture-employer.test   the employer's page
 *   https://boards.greenhouse.io            the embedded ATS application
 *   https://ads.doubleclick.net             an unrelated embedded widget
 *
 * The first two are already required hosts in the shipped manifest, so pointing
 * them here needs no manifest change and no extension configuration: the
 * workflow reaches a real session package exactly as it would in production.
 * The last three carry NO install-time authority whatsoever — which is the
 * whole point of the test.
 *
 * The hostnames match the Stage 3C-2 automated fixture so the manual evidence
 * lines up with the automated evidence.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adsPage, atsPage, employerPage, launcherPage, PROFILE } from "./pages.mjs";

const WEB_HOST = "xpertapply.com";
const API_HOST = "api.xpertapply.com";
const EMPLOYER_HOST = "careers.fixture-employer.test";
const ATS_HOST = "boards.greenhouse.io";
const ADS_HOST = "ads.doubleclick.net";

const EMPLOYER_ORIGIN = `https://${EMPLOYER_HOST}`;
const ATS_ORIGIN = `https://${ATS_HOST}`;
const ADS_ORIGIN = `https://${ADS_HOST}`;
const APPLICATION_URL = `${EMPLOYER_ORIGIN}/jobs/1/apply`;
const EXTENSION_ID = process.env.XPERTAPPLY_EXTENSION_ID ?? "";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "..", "dist");
const PROFILE_DIR = path.join(tmpdir(), "xpertapply-3cv2-profile");

/**
 * Which Chrome to drive.
 *
 * Chrome stable 137+ disables the `--load-extension` command-line switch, and
 * on 151 it is ignored outright — the browser starts with zero extensions and
 * the test silently proves nothing. Google Chrome for Testing is the same
 * Chrome build without that restriction, and Playwright already downloads it
 * for this repository, so it is preferred when present.
 *
 * Chrome stable is still usable, but only by loading the unpacked extension
 * through chrome://extensions by hand; the printed instructions say so.
 */
function findBrowser() {
  const cache = path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright");
  const candidates = [];
  try {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith("chromium-")) continue;
      const bin = path.join(cache, entry, "chrome-mac-arm64",
        "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (existsSync(bin)) candidates.push({ bin, build: Number(entry.split("-")[1]) || 0 });
    }
  } catch { /* no playwright cache on this machine */ }
  candidates.sort((a, b) => b.build - a.build);
  if (candidates[0]) return { bin: candidates[0].bin, forTesting: true };
  return {
    bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    forTesting: false
  };
}

/**
 * Verified answers, because Stage 3B will not write a value without answer
 * authority. Deliberately covers ONLY the safe identity fields: the
 * attestation, the non-US work-authorisation question and the negated
 * sponsorship question are left unanswerable on purpose, so a fill that touched
 * them would be visible as a defect rather than hidden by a missing answer.
 */
const ANSWERS = [
  ["email", PROFILE.email],
  ["first_name", PROFILE.first_name],
  ["last_name", PROFILE.last_name],
  ["phone", PROFILE.phone]
].map(([canonical_key, value]) => ({
  canonical_key, value, display_value: value,
  source: "explicit_user_answer", confidence: 1,
  sensitive: false, requires_review: false, verified: true
}));

const SESSION = {
  session_id: 55,
  ats_type: null,
  official_application_url: APPLICATION_URL,
  job: { title: "Software Engineer", company: "Fixture Employer", location: "Remote" },
  resume: { status: "ready", document_id: 1, download_url: null },
  cover_letter: { status: "ready", document_id: 2, download_url: null },
  profile: PROFILE
};

/** A minimal, valid, single-page PDF. Contains one line of synthetic text. */
function fixturePdf() {
  const body = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R"
      + "/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 68>>stream",
    "BT /F1 12 Tf 20 60 Td (XpertApply 3C-V2 fixture resume) Tj ET",
    "endstream endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF"
  ].join("\n");
  return Buffer.from(body, "latin1");
}

function makeCert() {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-3cv2-cert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=xpertapply-3cv2-fixture",
    "-addext",
    `subjectAltName=DNS:${WEB_HOST},DNS:${API_HOST},DNS:${EMPLOYER_HOST},DNS:${ATS_HOST},DNS:${ADS_HOST}`
  ], { stdio: "ignore" });
  return { dir, key: readFileSync(key), cert: readFileSync(cert) };
}

const { dir: certDir, key, cert } = makeCert();

const server = createServer({ key, cert }, (request, response) => {
  const host = (request.headers.host ?? "").split(":")[0];
  const url = request.url ?? "/";
  const html = (body) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  };
  const json = (value) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };

  if (host === API_HOST) {
    if (/\/application-sessions\/\d+\/(resume|cover-letter)/.test(url)) {
      const pdf = fixturePdf();
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="fixture-candidate-resume.pdf"',
        "Content-Length": pdf.length
      });
      return response.end(pdf);
    }
    if (url.endsWith("/application-sessions/token")) {
      return json({ session_token: "fixture-session-token", session: SESSION });
    }
    if (/\/application-sessions\/\d+\/answers$/.test(url)) {
      return json({ answers: ANSWERS, unresolved_questions: [], refreshed: false, profile_revision: "r1" });
    }
    if (/\/application-sessions\/\d+$/.test(url)) return json(SESSION);
    return json({ ok: true });
  }

  if (host === WEB_HOST) return html(launcherPage(APPLICATION_URL, EXTENSION_ID));
  if (host === ATS_HOST) return html(atsPage());
  if (host === ADS_HOST) return html(adsPage());
  // Anything the fixture does not model — including a form POST — is answered,
  // never acted on. A POST reaching here would itself be a finding.
  if (request.method === "POST") {
    console.log(`\n  *** UNEXPECTED POST ${host}${url} — record this as a FAILURE ***\n`);
  }
  return html(employerPage(ATS_ORIGIN, ADS_ORIGIN));
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const resolverRules = [
    `MAP ${WEB_HOST} 127.0.0.1:${port}`,
    `MAP ${API_HOST} 127.0.0.1:${port}`,
    `MAP ${EMPLOYER_HOST} 127.0.0.1:${port}`,
    `MAP ${ATS_HOST} 127.0.0.1:${port}`,
    `MAP ${ADS_HOST} 127.0.0.1:${port}`
  ].join(",");

  const browser = findBrowser();
  const chromeArgs = [
    `--user-data-dir="${PROFILE_DIR}"`,
    `--disable-extensions-except="${DIST}"`,
    `--load-extension="${DIST}"`,
    `--host-resolver-rules="${resolverRules}"`,
    // Only this throwaway profile trusts the per-run fixture certificate.
    // It exists solely so local HTTPS fixtures load, and must never appear in
    // any production or runtime configuration.
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
    // Read-only, used by e2e/manual/permissions.mjs to report granted origins.
    "--remote-debugging-port=9222",
    `"https://${WEB_HOST}/"`
  ].join(" \\\n  ");

  console.log(`
================================================================
 XPERTAPPLY — STAGE 3C-V2 FIXTURE  (listening on 127.0.0.1:${port})
================================================================

 Origins served (all resolve to this process, nothing leaves the machine):

   https://${WEB_HOST}/            launcher  — start the workflow here
   https://${API_HOST}/        session package + résumé
   ${EMPLOYER_ORIGIN}/jobs/1/apply
   ${ATS_ORIGIN}/embed/1
   ${ADS_ORIGIN}/widget

 Extension that will be loaded:
   ${DIST}

 Throwaway Chrome profile (safe to delete afterwards):
   ${PROFILE_DIR}

----------------------------------------------------------------
 LAUNCH CHROME  (copy the whole block into a second terminal)
----------------------------------------------------------------
${browser.forTesting
  ? " Using Google Chrome for Testing. Chrome stable 137+ ignores\n"
    + " --load-extension, so it would start with NO extension loaded."
  : " WARNING: Google Chrome for Testing was not found.\n"
    + " Chrome stable 137+ IGNORES --load-extension, so the command below may\n"
    + " start with no extension at all. If the launcher page reports the\n"
    + " extension as missing, open chrome://extensions in that window, turn on\n"
    + " Developer mode, choose 'Load unpacked' and select:\n"
    + `   ${DIST}\n`
    + " then reload the launcher page."}

"${browser.bin}" \\
  ${chromeArgs}

----------------------------------------------------------------
 Read the granted origins at any time, from a third terminal:

   node ${path.join(here, "permissions.mjs")}
----------------------------------------------------------------

 Leave this process running for the whole test. Ctrl-C to stop.
`);
});

process.on("SIGINT", () => {
  rmSync(certDir, { recursive: true, force: true });
  server.close(() => process.exit(0));
});
