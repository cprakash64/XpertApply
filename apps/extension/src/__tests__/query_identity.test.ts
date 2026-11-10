import { describe, expect, it } from "vitest";
import { urlsMatchForHandoff } from "../url";

/**
 * EXT-LIVE-10: two applications at the SAME path that differ only in a job-identifying query parameter are two jobs. Tracking
 * parameters never matter, and a redirect that keeps (or drops) the id is still the same application.
 */
const HOST = "https://careers.example-employer.test";
describe("query-based job identity", () => {
  it.each([
    ["jobId", "111", "222"],
    ["JobID", "111", "222"],
    ["job_id", "9001", "9002"],
    ["jobId", "1", "2"],                    // short ids are still ids
    ["reqId", "R-1001", "R-1002"],
    ["req_id", "1001", "1002"],
    ["requisitionId", "55501", "55502"],
    ["gh_jid", "4001234", "4001235"],
    ["id", "111", "222"],
    ["job", "111", "222"],
    ["position", "111", "222"],
    ["positionId", "111", "222"],
    ["postingId", "111", "222"],
    ["jid", "abc123", "abc124"]
  ])("%s=%s vs %s at one path are different applications", (key, one, two) => {
    expect(urlsMatchForHandoff(`${HOST}/apply?${key}=${one}`, `${HOST}/apply?${key}=${two}`)).toBe(false);
    expect(urlsMatchForHandoff(`${HOST}/careers/apply?${key}=${one}&utm_source=x`, `${HOST}/careers/apply?${key}=${two}&utm_source=x`)).toBe(false);
  });

  it("the same id is the same application, whatever tracking parameters and fragment say", () => {
    expect(urlsMatchForHandoff(`${HOST}/apply?jobId=111&utm_source=a#top`, `${HOST}/apply?utm_campaign=b&jobId=111`)).toBe(true);
    expect(urlsMatchForHandoff(`${HOST}/apply?JobID=111`, `${HOST}/apply?jobid=111`)).toBe(true);
    expect(urlsMatchForHandoff(`${HOST}/posting?jobId=111`, `${HOST}/apply?jobId=111`)).toBe(true);
  });

  it("tracking parameters alone never separate or join applications", () => {
    expect(urlsMatchForHandoff(`${HOST}/jobs/engineer/apply?utm_source=a`, `${HOST}/jobs/engineer/apply?utm_source=b`)).toBe(true);
    expect(urlsMatchForHandoff(`${HOST}/jobs/engineer/apply?ref=1`, `${HOST}/jobs/designer/apply?ref=1`)).toBe(false);
  });

  it("a redirect that keeps or drops the id on the same path is still one application", () => {
    expect(urlsMatchForHandoff(`${HOST}/apply?jobId=111`, `${HOST}/apply`)).toBe(true);
    expect(urlsMatchForHandoff(`${HOST}/apply?jobId=111`, `${HOST}/apply/step-2?jobId=111`)).toBe(true);
  });

  it("an id on one site never joins a different site", () => {
    expect(urlsMatchForHandoff(`${HOST}/apply?jobId=111`, "https://careers.other-employer.test/apply?jobId=111")).toBe(false);
  });
});
