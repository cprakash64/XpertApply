// Summarises one Playwright JSON report for scripts/e2e-gate.sh.
//   node e2e-gate-report.mjs <result.json> [failed-tests-out.txt]
// Prints machine-readable lines (COUNTS / FILE / FAILED) and, when a second
// argument is given, writes one `e2e/<file>:<line>` per failed test so the gate
// can re-run each in isolation. Always exits 0; the shell decides the verdict.
import fs from "node:fs";

const [, , jsonPath, failedOut] = process.argv;
let report;
try {
  report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
} catch {
  console.log("COUNTS unreadable=1");
  process.exit(0);
}

const strip = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const files = new Map();
const failed = [];
let total = 0;
let retried = 0;

const walk = (suite) => {
  for (const child of suite.suites ?? []) walk(child);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      total += 1;
      const counts = files.get(spec.file) ?? {};
      counts[test.status] = (counts[test.status] ?? 0) + 1;
      files.set(spec.file, counts);
      retried += Math.max(0, (test.results ?? []).length - 1);
      if (test.status === "unexpected" || test.status === "flaky") {
        const last = (test.results ?? []).slice(-1)[0] ?? {};
        failed.push({
          file: spec.file,
          line: spec.line,
          title: spec.title,
          ms: last.duration ?? 0,
          error: strip(last.error?.message).split("\n")[0].slice(0, 200)
        });
      }
    }
  }
};
for (const suite of report.suites ?? []) walk(suite);

const stats = report.stats ?? {};
console.log(
  `COUNTS total=${total} passed=${stats.expected ?? 0} failed=${stats.unexpected ?? 0} ` +
    `flaky=${stats.flaky ?? 0} skipped=${stats.skipped ?? 0} retried=${retried} ` +
    `files=${files.size} duration_s=${Math.round((stats.duration ?? 0) / 1000)}`
);
for (const [file, counts] of files) console.log(`FILE ${file} ${JSON.stringify(counts)}`);
for (const f of failed) {
  console.log(`FAILED ${f.file}:${f.line} [${f.ms}ms] ${f.title.slice(0, 90)} :: ${f.error}`);
}
if (failedOut) {
  const rows = failed.map((f) => `e2e/${f.file.replace(/^e2e\//, "")}:${f.line}`);
  fs.writeFileSync(failedOut, rows.join("\n") + (rows.length ? "\n" : ""));
}
