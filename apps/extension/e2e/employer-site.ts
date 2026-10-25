import { execFileSync } from "node:child_process";
import { createServer as createHttps, type Server } from "node:https";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type Site = { hits: string[]; clicks: { apply: number; submit: number }; close(): void; args: string[] };

/** Serve fixture pages over TLS under real hostnames (resolved to loopback by the spec's host-resolver rules). */
export async function site(routes: Record<string, (url: URL) => { status?: number; body: string; headers?: Record<string, string> }>, hosts = ["careers.withwaymo.com", "job-boards.greenhouse.io"]): Promise<Site> {
  const dir = mkdtempSync(path.join(tmpdir(), "xa-nav-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "1", "-subj", "/CN=employer.test"], { stdio: "ignore" });
  const state: Site = { hits: [], clicks: { apply: 0, submit: 0 }, close: () => undefined, args: [] };
  const server: Server = createHttps({ key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) }, (rq, rs) => {
    const host = String(rq.headers.host ?? "").split(":")[0];
    const url = new URL(rq.url ?? "/", `https://${host}`);
    state.hits.push(`${host}${url.pathname}`);
    const route = routes[`${host}${url.pathname}`] ?? routes[url.pathname];
    if (!route) { rs.writeHead(404, { "Content-Type": "text/plain" }); rs.end("not found"); return; }
    const out = route(url);
    rs.writeHead(out.status ?? 200, { "Content-Type": "text/html; charset=utf-8", ...(out.headers ?? {}) });
    rs.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.args = [`--host-resolver-rules=${hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`).join(",")}`, "--ignore-certificate-errors"];
  state.close = () => { server.closeAllConnections(); server.close(); };
  return state;
}
