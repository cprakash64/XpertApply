import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const wrapper = readFileSync(resolve(root, "scripts/production-compose.sh"), "utf8");
// Exercise the actual environment/command construction without bypassing or
// executing the production-only host, user, path gates or Docker operations.
const construction = wrapper.slice(wrapper.indexOf("# Compose gives"), wrapper.indexOf("\npreflight()"));
const id = "gnibjomjfdobadlockphjiibbpmiehcj";
function command(extra: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail
EXPECTED_USER=luna
SAFE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV_FILE=/test/private.env
BASE_COMPOSE=/test/docker-compose.yml
PRODUCTION_COMPOSE=/test/compose.production.yml
fail() { exit 42; }
${construction}
printf '%s\\0' "\${compose_command[@]}"`], {
    env: { PATH: process.env.PATH, ...extra } as unknown as NodeJS.ProcessEnv, encoding: "utf8"
  });
}
function sanitized(extra: Record<string, string> = {}) {
  const result = command(extra);
  expect(result.status).toBe(0);
  const argv = result.stdout.split("\0").filter(Boolean);
  expect(argv.slice(0, 2)).toEqual(["env", "-i"]);
  expect(argv.slice(argv.indexOf("docker"))).toEqual([
    "docker", "compose", "--env-file", "/test/private.env",
    "-f", "/test/docker-compose.yml", "-f", "/test/compose.production.yml"
  ]);
  const expected = Object.fromEntries(argv.slice(2, argv.indexOf("docker")).map(value => {
    const equal = value.indexOf("=");
    return [value.slice(0, equal), value.slice(equal + 1)];
  }));
  const actual = execFileSync("env", [...argv.slice(1, argv.indexOf("docker")), "/usr/bin/env"], { encoding: "utf8" });
  expect(Object.fromEntries(actual.trim().split("\n").map(value => {
    const equal = value.indexOf("=");
    return [value.slice(0, equal), value.slice(equal + 1)];
  }))).toEqual(expected);
  return expected;
}

describe("production Compose public-build isolation", () => {
  it("retains only the original four environment values when no ID is supplied", () => {
    expect(sanitized()).toEqual({ HOME: "/home/luna", USER: "luna", LOGNAME: "luna",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" });
  });

  it("forwards only an explicitly supplied canonical public ID", () => {
    const env = sanitized({ NEXT_PUBLIC_CHROME_EXTENSION_ID: id, ARBITRARY_CALLER_TEST: "discard",
      AWS_SECRET_ACCESS_KEY: "synthetic-test-only", DATABASE_URL: "synthetic-test-only",
      AUTH_SECRET: "synthetic-test-only", DOCKER_HOST: "synthetic-test-only",
      COMPOSE_PROJECT_NAME: "wrong", NEXT_PUBLIC_API_URL: "https://wrong.example",
      NEXT_PUBLIC_CHROME_EXTENSION_URL: "https://wrong.example" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LOGNAME", "NEXT_PUBLIC_CHROME_EXTENSION_ID", "PATH", "USER"]);
    expect(env.NEXT_PUBLIC_CHROME_EXTENSION_ID).toBe(id);
    expect(env).not.toHaveProperty("NEXT_PUBLIC_CHROME_EXTENSION_URL");
  });

  it.each(["", id.toUpperCase(), ` ${id}`, `${id}\n`, id.slice(1), `q${id.slice(1)}`])(
    "rejects invalid explicitly supplied ID %j", value => {
      expect(command({ NEXT_PUBLIC_CHROME_EXTENSION_ID: value }).status).toBe(42);
    }
  );

  it("resolves real Compose interpolation without changing non-Web services or runtime configuration", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "xpertapply-wrapper-test-"));
    try {
      const envFile = resolve(directory, "fixture.env");
      // Synthetic local values only; never read or print the production .env.
      writeFileSync(envFile, "NEXT_PUBLIC_API_URL=https://api.xpertapply.com\nNEXT_PUBLIC_SITE_URL=https://xpertapply.com\nPOSTGRES_PASSWORD=synthetic-test-only\n");
      const docker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
      const args = ["compose", "--project-name", "xpertapply", "--env-file", envFile,
        "-f", resolve(root, "docker-compose.yml"), "-f", resolve(root, "compose.production.yml"), "config", "--format", "json"];
      // Local HOME is used only to discover the locally installed Compose plugin;
      // the wrapper environment and production HOME are asserted separately.
      const config = (env: Record<string, string>) => JSON.parse(execFileSync(docker, args, {env: { ...env, HOME: process.env.HOME } as unknown as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}));
      const before = config(sanitized());
      const after = config(sanitized({ NEXT_PUBLIC_CHROME_EXTENSION_ID: id, NEXT_PUBLIC_CHROME_EXTENSION_URL: "https://wrong.example" }));
      expect(after.name).toBe("xpertapply");
      expect(after.services.web.build.args.NEXT_PUBLIC_CHROME_EXTENSION_ID).toBe(id);
      expect(after.services.web.build.args.NEXT_PUBLIC_CHROME_EXTENSION_URL).toBe("");
      expect(after.services.web.environment).toEqual(before.services.web.environment);
      expect(after.services.web.environment.NEXT_PUBLIC_CHROME_EXTENSION_URL).toBe("");
      expect(after.services.web.environment).not.toHaveProperty("NEXT_PUBLIC_CHROME_EXTENSION_ID");
      expect(after.services.web.build.args.NEXT_PUBLIC_API_URL).toBe("https://api.xpertapply.com");
      expect(after.services.web.build.args.NEXT_PUBLIC_SITE_URL).toBe("https://xpertapply.com");
      for (const service of ["api", "worker", "scheduler", "postgres", "redis"]) {
        expect(after.services[service]).toEqual(before.services[service]);
      }
      const normalized = structuredClone(after);
      normalized.services.web.build.args.NEXT_PUBLIC_CHROME_EXTENSION_ID = before.services.web.build.args.NEXT_PUBLIC_CHROME_EXTENSION_ID;
      expect(normalized).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
