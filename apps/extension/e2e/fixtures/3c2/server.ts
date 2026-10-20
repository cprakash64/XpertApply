/**
 * Three genuinely different origins on one local HTTPS server.
 *
 * Stage 3C-2 needs employer, ATS and unrelated-widget frames whose ORIGINS the
 * extension's trust policy can actually tell apart. Loopback cannot supply
 * that: `originPatternFor` collapses every port on `localhost` into a single
 * `http://localhost/*` grant, so granting the employer would grant the ad frame
 * too, and `originJoinsWorkflow` would reject a loopback "ATS" anyway because it
 * matches neither the workflow's registrable domain nor an allow-listed ATS
 * host. The policy under test is about hostnames, so the fixture has to have
 * hostnames.
 *
 * Chrome's own `--host-resolver-rules` maps them to this server, so nothing
 * leaves the machine, `/etc/hosts` is untouched and no sudo is involved. The
 * certificate is generated per run and trusted only by the throwaway profile.
 */
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer, type Server } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The employer whose careers site the workflow starts on. */
export const EMPLOYER_HOST = "careers.fixture-employer.test";
/** An allow-listed ATS host — trusted by originJoinsWorkflow, and ungranted. */
export const ATS_HOST = "boards.greenhouse.io";
/** An unrelated embedded widget. Never trusted, never granted, never asked for. */
export const ADS_HOST = "ads.doubleclick.net";
/** XpertApply's own API. A required host permission already, so pointing it at
 * the fixture lets the workflow reach a session package without any real
 * network call and without touching the extension's configuration. */
export const API_HOST = "api.xpertapply.com";

export const EMPLOYER_ORIGIN = `https://${EMPLOYER_HOST}`;
/** The page the workflow launches at. */
export const APPLICATION_URL = `https://${EMPLOYER_HOST}/jobs/1/apply`;
export const ATS_ORIGIN = `https://${ATS_HOST}`;
export const ADS_ORIGIN = `https://${ADS_HOST}`;
export const API_ORIGIN = `https://${API_HOST}`;

/** Synthetic profile. Every value is obviously fake and belongs to no one. */
const PROFILE = {
  email: "fixture.candidate@example.test",
  full_name: "Fixture Candidate",
  first_name: "Fixture",
  last_name: "Candidate",
  phone: "+1-555-0100"
};

/** Verified answers the fill path is allowed to act on. */
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

function sessionBody(applicationUrl: string) {
  return {
    session_id: 55,
    ats_type: null,
    official_application_url: applicationUrl,
    job: { title: "Software Engineer", company: "Fixture Employer" },
    resume: { status: "ready", document_id: 1, download_url: null },
    cover_letter: { status: "ready", document_id: 2, download_url: null },
    profile: PROFILE
  };
}

/** A marker any XpertApply content script leaves on the document it runs in. */
const PROBE = `<script>
  window.__xaFixture = { origin: location.origin };
</script>`;

/** The employer page. No application fields of its own — the application is in
 * the embedded ATS frame, which is the shape this stage exists to handle. */
function employerPage(): string {
  return `<!doctype html><html><head><title>Careers</title></head><body>
    <h1>Software Engineer</h1>
    <p>Apply below.</p>
    <!-- The ad frame is deliberately FIRST: DOM order used to decide the winner. -->
    <iframe id="ads" src="${ADS_ORIGIN}/widget" width="300" height="100"></iframe>
    <iframe id="ats" src="${ATS_ORIGIN}/embed/1" width="700" height="600"></iframe>
    ${PROBE}
  </body></html>`;
}

/** The real application, inside the ungranted ATS origin. */
function atsPage(): string {
  return `<!doctype html><html><head><title>Apply</title></head><body>
    <form id="application-form" action="/submit" method="post">
      <label for="first_name">First name</label><input id="first_name" name="first_name" />
      <label for="last_name">Last name</label><input id="last_name" name="last_name" />
      <label for="email">Email</label><input id="email" name="email" type="email" />
      <label for="phone">Phone</label><input id="phone" name="phone" />
      <button type="submit" id="final-submit">Submit application</button>
    </form>
    ${PROBE}
  </body></html>`;
}

/** An unrelated widget that is deliberately MORE application-shaped than the
 * real application, so shape alone would pick it. */
function adsPage(): string {
  return `<!doctype html><html><head><title>Sponsored</title></head><body>
    <form id="lead-form">
      <label for="email">Email</label><input id="email" name="email" type="email" />
      <label for="name">Name</label><input id="name" name="name" />
      <label for="phone">Phone</label><input id="phone" name="phone" />
      <label for="city">City</label><input id="city" name="city" />
      <label for="zip">Zip</label><input id="zip" name="zip" />
    </form>
    ${PROBE}
  </body></html>`;
}

export interface Fixture {
  port: number;
  /** Chromium args that point the three hostnames at this server. */
  chromeArgs: string[];
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-3c2-cert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=xpertapply-3c2-fixture",
    "-addext", `subjectAltName=DNS:${EMPLOYER_HOST},DNS:${ATS_HOST},DNS:${ADS_HOST}`
  ], { stdio: "ignore" });

  const server: Server = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      const host = (request.headers.host ?? "").split(":")[0];
      const url = request.url ?? "/";

      // XpertApply's API, served locally so the workflow can actually reach a
      // session package. No real network call, no real employer, no real person.
      if (host === API_HOST) {
        const json = (value: unknown) => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (url.endsWith("/application-sessions/token")) {
          return json({ session_token: "fixture-session-token", session: sessionBody(APPLICATION_URL) });
        }
        if (/\/application-sessions\/\d+\/answers$/.test(url)) {
          // Verified answers, because Stage 3B will not write a value without
          // answer authority — a field reached but left empty proves injection,
          // not fill. Every value here is synthetic.
          return json({
            answers: ANSWERS, unresolved_questions: [], refreshed: false, profile_revision: "r1"
          });
        }
        if (/\/application-sessions\/\d+$/.test(url)) {
          return json(sessionBody(APPLICATION_URL));
        }
        return json({ ok: true });
      }

      const body = host === ATS_HOST ? atsPage() : host === ADS_HOST ? adsPage() : employerPage();
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    chromeArgs: [
      `--host-resolver-rules=MAP ${EMPLOYER_HOST} 127.0.0.1:${port},MAP ${ATS_HOST} 127.0.0.1:${port},`
        + `MAP ${ADS_HOST} 127.0.0.1:${port},MAP ${API_HOST} 127.0.0.1:${port}`,
      // The certificate is generated for this run only and the profile is
      // discarded with it; nothing outside this test trusts it.
      "--ignore-certificate-errors"
    ],
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
