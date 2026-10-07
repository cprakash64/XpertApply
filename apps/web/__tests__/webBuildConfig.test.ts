import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("public Store ID build authority", () => {
  it("passes the private environment ID through the Web Compose build argument", () => {
    const web = read("docker-compose.yml").split("\n  web:\n")[1].split("\nvolumes:")[0];
    expect(web).toContain("        NEXT_PUBLIC_CHROME_EXTENSION_ID: ${NEXT_PUBLIC_CHROME_EXTENSION_ID:-}");
    expect(read("compose.production.yml")).not.toContain("NEXT_PUBLIC_CHROME_EXTENSION_ID");
  });

  it("makes the argument available before the Next production build", () => {
    const docker = read("apps/web/Dockerfile");
    expect(docker).toContain('ARG NEXT_PUBLIC_CHROME_EXTENSION_ID=""');
    expect(docker).toContain("NEXT_PUBLIC_CHROME_EXTENSION_ID=$NEXT_PUBLIC_CHROME_EXTENSION_ID");
    expect(docker.indexOf("NEXT_PUBLIC_CHROME_EXTENSION_ID=$NEXT_PUBLIC_CHROME_EXTENSION_ID")).toBeLessThan(docker.indexOf("RUN npm run build"));
    expect(docker).toContain("RUN npm ci");
  });

  it("preserves optional URL authority and never bakes the product ID into plumbing", () => {
    const docker = read("apps/web/Dockerfile");
    expect(docker).toContain('ARG NEXT_PUBLIC_CHROME_EXTENSION_URL=""');
    expect(docker).toContain("NEXT_PUBLIC_CHROME_EXTENSION_URL=$NEXT_PUBLIC_CHROME_EXTENSION_URL");
    for (const path of ["apps/web/Dockerfile", "docker-compose.yml", "compose.production.yml", "apps/web/lib/siteConfig.ts"]) {
      expect(read(path)).not.toContain("gnibjomjfdobadlockphjiibbpmiehcj");
    }
  });
});
