import { describe, expect, it } from "vitest";
import { urlsMatchForHandoff } from "../url";

/** EXT-LIVE-09: a hostname, an employer path prefix or a shared title word never proves two postings are the same application. */
const NOT_SAME: Array<[string, string, string]> = [
  ["Tesla: two jobs", "https://www.tesla.com/careers/search/job/software-engineer-infotainment-201111", "https://www.tesla.com/careers/search/job/software-engineer-autopilot-202222"],
  ["Tesla: apply forms of two jobs", "https://www.tesla.com/careers/search/job/apply/201111", "https://www.tesla.com/careers/search/job/apply/202222"],
  ["custom employer, shared prefix, similar titles", "https://careers.example.com/jobs/senior-backend-engineer", "https://careers.example.com/jobs/senior-backend-engineer-payments"],
  ["custom employer, department listing vs job", "https://careers.example.com/jobs/engineering", "https://careers.example.com/jobs/engineering/staff-platform-engineer"],
  ["custom employer, board root vs job", "https://careers.example.com/careers", "https://careers.example.com/careers/jobs/ml-engineer"],
  ["SmartRecruiters: two jobs, one company", "https://jobs.smartrecruiters.com/Acme/743999111111111-data-engineer", "https://jobs.smartrecruiters.com/Acme/743999222222222-data-engineer"],
  ["BambooHR: two jobs", "https://acme.bamboohr.com/careers/42", "https://acme.bamboohr.com/careers/43"],
  ["Teamtailor: two jobs", "https://acme.teamtailor.com/jobs/5821234-engineer", "https://acme.teamtailor.com/jobs/5821999-engineer"],
  ["applytojob: two jobs, same word", "https://acme.applytojob.com/apply/AbC123/Software-Engineer", "https://acme.applytojob.com/apply/ZyX987/Software-Engineer"],
  ["Rippling: two jobs", "https://ats.rippling.com/acme/jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "https://ats.rippling.com/acme/jobs/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
  ["different host, same path", "https://careers.one.example/jobs/ml-engineer", "https://careers.two.example/jobs/ml-engineer"]
];
const SAME: Array<[string, string, string]> = [
  ["Tesla: posting to its apply form (shared posting id)", "https://www.tesla.com/careers/search/job/software-engineer-infotainment-201111", "https://www.tesla.com/careers/search/job/apply/201111"],
  ["custom: posting to /apply", "https://careers.example.com/jobs/ml-engineer", "https://careers.example.com/jobs/ml-engineer/apply"],
  ["custom: application step continuation", "https://careers.example.com/jobs/ml-engineer/apply", "https://careers.example.com/jobs/ml-engineer/apply/step-2"],
  ["SmartRecruiters: posting to oneclick-style apply with the same id", "https://jobs.smartrecruiters.com/Acme/743999111111111-data-engineer", "https://jobs.smartrecruiters.com/Acme/743999111111111-data-engineer/apply"],
  ["identical URL", "https://careers.example.com/jobs/ml-engineer?utm=x", "https://careers.example.com/jobs/ml-engineer#top"],
];

describe("EXT-LIVE-09 universal application matching", () => {
  for (const [name, a, b] of NOT_SAME) it(`different applications: ${name}`, () => { expect(urlsMatchForHandoff(a, b)).toBe(false); expect(urlsMatchForHandoff(b, a)).toBe(false); });
  for (const [name, a, b] of SAME) it(`same application: ${name}`, () => { expect(urlsMatchForHandoff(a, b)).toBe(true); expect(urlsMatchForHandoff(b, a)).toBe(true); });
});
