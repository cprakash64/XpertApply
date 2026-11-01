import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export type FixtureRequest = {
  url(): string;
  method(): string;
  postData(): string | null;
  headers(): Record<string, string>;
};
export type FixtureRoute = {
  request(): FixtureRequest;
  fulfill(response: { status: number; contentType: string; body: string; headers?: Record<string, string> }): Promise<void>;
};

type Handler = (route: FixtureRoute, request: FixtureRequest) => unknown;

/** An owned loopback backend: worker fetches exercise real HTTP without a
 * browser-protocol interception round trip for every package prerequisite. */
export class OwnedPackageFixture {
  private readonly handlers: { pattern: RegExp; handler: Handler }[] = [];
  private server: Server;
  readonly unconfigured: { path: string; method: string }[] = [];
  origin = "";
  readonly sessionToken = `synthetic-${randomUUID()}`;
  readonly requests: { at: number; path: string; method: string; responded: boolean; status?: number; responseAt?: number }[] = [];

  constructor(html: string) {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", this.origin || "http://localhost");
      if (!url.pathname.startsWith("/application-sessions/")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      const row = { at: performance.timeOrigin + performance.now(), responseAt: undefined as number | undefined, path: url.pathname, method: req.method ?? "GET", responded: false, status: undefined as number | undefined };
      this.requests.push(row);
      if (url.pathname !== "/application-sessions/token" && req.headers.authorization !== `Bearer ${this.sessionToken}`) {
        row.responded = true; row.status = 401; row.responseAt = performance.timeOrigin + performance.now();
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "fixture_session_owner_mismatch" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks).toString();
      const request: FixtureRequest = {
        url: () => url.href,
        method: () => req.method ?? "GET",
        postData: () => data || null,
        headers: () => Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value ?? ""]))
      };
      const route: FixtureRoute = {
        request: () => request,
        fulfill: async response => {
          row.responded = true;
          row.status = response.status;
          row.responseAt = performance.timeOrigin + performance.now();
          res.writeHead(response.status, { "Content-Type": response.contentType, ...response.headers });
          res.end(response.body);
        }
      };
      const owner = [...this.handlers].reverse().find(entry => entry.pattern.test(url.pathname));
      try {
        if (owner) await owner.handler(route, request);
        else {
          this.unconfigured.push({ path: url.pathname, method: req.method ?? "GET" });
          await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "unconfigured_fixture_endpoint" }) });
        }
      } catch {
        if (!res.headersSent) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "fixture_handler_failed" }) });
      }
    });
  }

  /** Authenticated PDF download, not a workflow-resume/state transition. */
  async document(sessionId: number, kind: "resume" | "cover-letter", pdf: string) {
    await this.route(`**/application-sessions/*/${kind}`, route => {
      const request = route.request();
      const url = new URL(request.url());
      const current = url.pathname === `/application-sessions/${sessionId}/${kind}`;
      if (!current) return route.fulfill({status:404,contentType:"application/json",body:JSON.stringify({detail:"Application session not found"})});
      if (request.method() !== "GET") return route.fulfill({status:405,contentType:"application/json",body:JSON.stringify({detail:"Method Not Allowed"})});
      if ((url.searchParams.get("fmt") ?? "pdf") !== "pdf") return route.fulfill({status:422,contentType:"application/json",body:JSON.stringify({detail:"Invalid document format"})});
      return route.fulfill({status:200,contentType:"application/pdf",headers:{"Content-Disposition":`attachment; filename="synthetic-${kind}.pdf"`},body:pdf});
    });
  }

  async start() {
    await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve));
    this.origin = `http://localhost:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  async route(pattern: string, handler: Handler) {
    const source = pattern.replace(/^\*\*/, "").split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    this.handlers.push({ pattern: new RegExp(`^${source}$`), handler });
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (this.unconfigured.length) throw new Error(`Unconfigured owned API endpoints: ${JSON.stringify(this.unconfigured)}`);
  }
}

/** A blank synthetic one-page PDF; no personal content or external resources. */
export function syntheticSessionPdf(): string {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);
  pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
