/* AUDIT ARTIFACT — temporary; not production code. */
import { describe, it } from "vitest";
import { appendFileSync } from "node:fs";
import { probeFrame } from "../frames/probe";
import { discoverFields } from "../fields/discovery";

const OUT = "/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/449891c0-0782-4c8f-84fa-f25a9ad50a94/scratchpad/audit/perf-results.txt";

function buildForm(n: number): void {
  const parts: string[] = ["<form id='app'>"];
  for (let i = 0; i < n; i++) {
    parts.push(
      `<div class="fg"><label for="f${i}">Field number ${i} first name email phone</label>` +
      `<input id="f${i}" name="field_${i}" type="text" required></div>`
    );
  }
  parts.push("<input type='file' id='resume'><button type='submit'>Submit application</button></form>");
  document.body.innerHTML = parts.join("");
}

for (const n of [100, 250, 500, 1000, 2000]) {
  describe(`AUDIT perf n=${n}`, () => {
    it("probeFrame + discoverFields", () => {
      buildForm(n);
      const t0 = Date.now();
      const p = probeFrame(document);
      const t1 = Date.now();
      let found = -1;
      try { found = discoverFields(document).length; } catch { /* ignore */ }
      const t2 = Date.now();
      appendFileSync(OUT, `n=${n} probeFrame_ms=${t1 - t0} discoverFields_ms=${t2 - t1} inputs=${p.visibleInputs} cands=${p.candidateCount} discovered=${found}\n`);
    }, 900000);
  });
}
