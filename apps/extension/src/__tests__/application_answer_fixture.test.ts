import { describe, expect, it } from "vitest";
import { OwnedPackageFixture } from "../../e2e/owned-package-fixture";

describe("application-answer owned package backend", () => {
  it("keeps token exchange distinct from the session endpoint", async () => {
    const fixture = await new OwnedPackageFixture("<form></form>").start();
    try {
      await fixture.route("**/application-sessions/token", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_token: fixture.sessionToken, session: { session_id: 55 } }) }));
      await fixture.route("**/application-sessions/55", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_id: 55 }) }));
      const exchanged = await (await fetch(`${fixture.origin}/application-sessions/token`, { method: "POST" })).json();
      expect(exchanged.session_token).toBe(fixture.sessionToken);
      const session = await fetch(`${fixture.origin}/application-sessions/55`, { headers: { Authorization: `Bearer ${exchanged.session_token}` } });
      expect(await session.json()).toEqual({ session_id: 55 });
      expect(fixture.requests.every(request => request.responded && request.status === 200)).toBe(true);
    } finally { await fixture.close(); }
  });

  it("rejects a credential from another test-owned backend", async () => {
    const first = await new OwnedPackageFixture("<form></form>").start();
    const second = await new OwnedPackageFixture("<form></form>").start();
    try {
      await second.route("**/application-sessions/55", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session_id: 55 }) }));
      expect((await fetch(`${second.origin}/application-sessions/55`, { headers: { Authorization: `Bearer ${first.sessionToken}` } })).status).toBe(401);
      expect((await fetch(`${second.origin}/application-sessions/55`, { headers: { Authorization: `Bearer ${second.sessionToken}` } })).status).toBe(200);
      expect(first.requests).toHaveLength(0);
    } finally { await first.close(); await second.close(); }
  });
});

describe("authenticated session PDF downloads", () => {
  it("serves the current prepared document and rejects other sessions, methods and credentials", async () => {
    const { syntheticSessionPdf } = await import("../../e2e/owned-package-fixture");
    const fixture=await new OwnedPackageFixture("<form></form>").start();
    try {
      const pdf=syntheticSessionPdf();await fixture.document(55,"resume",pdf);
      const headers={Authorization:`Bearer ${fixture.sessionToken}`};
      const response=await fetch(`${fixture.origin}/application-sessions/55/resume?fmt=pdf`,{headers});
      expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("application/pdf");expect(response.headers.get("content-disposition")).toContain("synthetic-resume.pdf");expect(await response.text()).toBe(pdf);
      expect((await fetch(`${fixture.origin}/application-sessions/56/resume?fmt=pdf`,{headers})).status).toBe(404);
      expect((await fetch(`${fixture.origin}/application-sessions/55/resume?fmt=pdf`,{headers:{Authorization:"Bearer stale-fixture-credential"}})).status).toBe(401);
      expect((await fetch(`${fixture.origin}/application-sessions/55/resume?fmt=pdf`,{headers,method:"POST"})).status).toBe(405);
      expect((await fetch(`${fixture.origin}/application-sessions/55/resume?fmt=invalid`,{headers})).status).toBe(422);
      expect(fixture.unconfigured).toEqual([]);
    } finally {await fixture.close();}
  });
});

 describe("owned fixture missing routes", () => {
  it("fails locally without a production fallback", async () => {
    const fixture = await new OwnedPackageFixture("<form></form>").start();
    const response = await fetch(`${fixture.origin}/application-sessions/55/unconfigured`, { headers: { Authorization: `Bearer ${fixture.sessionToken}` } });
    expect(new URL(response.url).hostname).toBe("localhost");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "unconfigured_fixture_endpoint" });
    expect(fixture.unconfigured).toEqual([{path:"/application-sessions/55/unconfigured",method:"GET"}]);
    expect(fixture.requests).toHaveLength(1);
    await expect(fixture.close()).rejects.toThrow("Unconfigured owned API endpoints");
  });
});
