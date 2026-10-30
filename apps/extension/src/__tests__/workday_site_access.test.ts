import { describe, expect, it } from "vitest";
import { applicationProviderForUrl, providerForUrl } from "../ats/providers";

/**
 * EXT-E2B: Chrome's optional site-access request for a Workday tenant. The worker asks only for a tenant's APPLICATION page, never
 * for its job description or its home page, so the request is a consequence of the user reaching the application.
 */
const TENANT = "https://generalmotors.wd5.myworkdayjobs.com/en-US/Careers_GM";

describe("which Workday pages ask Chrome for site access", () => {
  it("recognises a tenant host as Workday, limited", () => {
    expect(providerForUrl(`${TENANT}/job/Warren-Michigan/Engineer_JR-1`)?.id).toBe("workday");
    expect(providerForUrl(`${TENANT}`)?.support).toBe("limited");
  });

  it.each([
    [`${TENANT}/job/Warren-Michigan/Engineer_JR-1/apply`, true],
    [`${TENANT}/job/Warren-Michigan/Engineer_JR-1/apply/applyManually`, true],
    [`${TENANT}/job/Warren-Michigan/Engineer_JR-1/apply/autofillWithResume`, true],
    [`${TENANT}/job/Warren-Michigan/Engineer_JR-1`, false],
    [`${TENANT}/job/Warren-Michigan/Applications-Engineer_JR-2`, false],
    [`${TENANT}`, false],
    ["https://generalmotors.wd5.myworkdayjobs.com.evil.test/en-US/Careers_GM/job/x/apply", false]
  ])("%s -> asks for access: %s", (url, asks) => {
    expect(applicationProviderForUrl(url) !== null).toBe(asks);
  });
});
