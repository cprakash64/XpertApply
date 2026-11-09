import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answer } from "./cws-p1-launch-harness";

/** Shared owned-fixture constants for the Workday specs (EXT-LIVE-06). */
export const HOST = "acme.wd5.myworkdayjobs.com";
export const APPLY = "/en-US/Careers/job/Phoenix/Engineer_JR1/apply/applyManually";
export const URL_ = `https://${HOST}${APPLY}`;
const TEMPLATE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workday-app.html"), "utf8");
export const fixture = (cfg: Record<string, unknown>) => TEMPLATE.replace("__CFG__", JSON.stringify(cfg));

export const EXPERIENCE = [
  { company: "Acme Robotics", title: "Senior Engineer", location: "Phoenix, AZ", start_date: "2021-03", currently_working: true, description: "Led the controls team." },
  { company: "Beta Systems", title: "Software Engineer", location: "Tempe, AZ", start_date: "2018-06", end_date: "2021-02", description: "Built the telemetry service." },
  { company: "Gamma Labs", title: "Intern", location: "Mesa, AZ", start_date: "2017-05", end_date: "2017-08" }
];
export const EDUCATION = [
  { school: "Arizona State University", degree: "Master of Science", major: "Computer Science", start_date: "2016-08", end_date: "2018-05", gpa: "3.8" },
  { school: "University of Arizona", degree: "Bachelor of Science", major: "Data Science", start_date: "2012-08", end_date: "2016-05" }
];
export const PROFILE = {
  first_name: "Riley", last_name: "Candidate", email: "riley@example.test", phone: "6025550199", city: "Phoenix",
  experience: EXPERIENCE, education: EDUCATION, linkedin_url: "https://www.linkedin.com/in/riley-candidate", github_url: "https://github.com/riley-candidate"
};
export const ANSWERS = [
  answer("work_authorization_us", "Yes"),
  answer("first_name", "Riley"), answer("last_name", "Candidate"), answer("email", "riley@example.test"), answer("phone_national", "6025550199"), answer("phone", "6025550199"),
  answer("city", "Phoenix"), answer("state", "Arizona"), answer("country", "United States of America"), answer("phone_country", "United States of America (+1)"),
  answer("referral_source", "Company website")
];
export const keyFor = (t: string): string | null =>
  /first name/i.test(t) ? "first_name" : /last name/i.test(t) ? "last_name" : /^e-?mail/i.test(t) ? "email" : /^phone number/i.test(t) ? "phone_national" : /^city/i.test(t) ? "city"
  : /^state/i.test(t) ? "state" : /^country phone code/i.test(t) ? "phone_country" : /^phone device/i.test(t) ? "phone_device_type" : /^country/i.test(t) ? "country" : /how did you hear/i.test(t) ? "referral_source" : /legally authorized/i.test(t) ? "work_authorization_us" : null;

