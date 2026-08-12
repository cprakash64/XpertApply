/**
 * Listing page versus application form.
 *
 * Root cause this locks down: a job LISTING whose only call to action reads
 * "Apply to this job" produced no activation candidate at all, because the
 * eligibility rule required the accessible name to be exactly `apply` or
 * `apply now`. The extension therefore sat in "Detecting fields (attempt N)"
 * polling a page that was never going to grow a form.
 *
 * Fixtures are sanitized, hand-written approximations of real listing markup.
 * Nothing here contacts a real employer site.
 */

import { describe, expect, it } from "vitest";
import { findActivationCandidates, selectActivationControl } from "../ats/applicationSurface";
import {
  classifyPage,
  findSafeConsentDismissal,
  hasConsentOverlay,
  isEmployerAuthPage
} from "../ats/pageState";

function mount(html: string): Document {
  document.documentElement.innerHTML = `<head></head><body>${html}</body>`;
  return document;
}

/** A listing page shaped like the reported TikTok one: description, a cookie
 * banner, a search box, and one job-specific Apply CTA in the main content. */
const TIKTOK_STYLE_LISTING = `
  <header>
    <nav><a href="/careers">Careers</a><a href="/search">Search</a></nav>
  </header>
  <main>
    <h1>Software Engineer, Recommendation Infrastructure</h1>
    <p>We are looking for engineers to build large-scale systems.</p>
    <div class="job-detail-actions">
      <button type="button">Apply to this job</button>
    </div>
  </main>
  <div id="cookie-banner" style="position:fixed;width:900px;height:180px">
    <p>We use cookies.</p>
    <button>Accept all cookies</button>
    <button>Reject non-essential</button>
  </div>
`;

describe("listing page with a job-specific Apply CTA", () => {
  it("finds the Apply to this job control", () => {
    mount(TIKTOK_STYLE_LISTING);
    const candidate = selectActivationControl(document);
    expect(candidate).not.toBeNull();
    expect(candidate!.element.textContent).toBe("Apply to this job");
    expect(candidate!.reason).toContain("job_specific_apply_cta");
  });

  it("classifies the page as apply_cta_detected, not as a form still loading", () => {
    mount(TIKTOK_STYLE_LISTING);
    const page = classifyPage(document);
    expect(page.state).toBe("apply_cta_detected");
    expect(page.candidate?.element.textContent).toBe("Apply to this job");
  });

  it("notices the cookie overlay without acting on it", () => {
    mount(TIKTOK_STYLE_LISTING);
    expect(classifyPage(document).obstructed).toBe(true);
  });

  it.each([
    "Apply to this job",
    "Apply for this position",
    "Apply to this role",
    "Start application",
    "Start your application",
    "Continue application",
    "Begin the application"
  ])("accepts the approved phrase %s in the job content", (label) => {
    mount(`<main><h1>Engineer</h1><button>${label}</button></main>`);
    expect(selectActivationControl(document), label).not.toBeNull();
  });
});

describe("choosing between competing Apply controls", () => {
  it("prefers the job-content CTA over a header-level Apply", () => {
    mount(`
      <header><button>Apply</button></header>
      <main><h1>Engineer</h1><button>Apply to this job</button></main>
    `);
    const candidate = selectActivationControl(document);
    expect(candidate!.element.textContent).toBe("Apply to this job");
  });

  it("never activates a header-only Apply shortcut", () => {
    mount(`<header><nav><button>Apply</button></nav></header><main><h1>Engineer</h1></main>`);
    expect(selectActivationControl(document)).toBeNull();
  });

  it("ignores an Apply link for a different job", () => {
    mount(`<main><h1>Engineer</h1><button>Apply to other roles</button></main>`);
    expect(selectActivationControl(document)).toBeNull();
  });
});

describe("controls that must never be clicked", () => {
  it.each([
    ["final submit", "<main><button>Submit application</button></main>"],
    ["cookie accept", "<main><button>Accept all cookies</button></main>"],
    ["cookie consent", "<main><button>Cookie settings</button></main>"],
    ["newsletter", "<main><button>Subscribe to job alerts</button></main>"],
    ["sign in", "<main><button>Sign in to apply</button></main>"],
    ["create account", "<main><button>Sign up</button></main>"],
    ["save job", "<main><button>Save this job</button></main>"],
    ["share", "<main><button>Share this job</button></main>"],
    ["applied chip", "<main><button>Applied</button></main>"]
  ])("refuses %s", (_label, html) => {
    mount(html);
    expect(selectActivationControl(document)).toBeNull();
  });

  it("refuses a hidden Apply control", () => {
    mount(`<main><h1>Engineer</h1><button style="display:none">Apply to this job</button></main>`);
    expect(selectActivationControl(document)).toBeNull();
  });

  it("refuses a disabled Apply control", () => {
    mount(`<main><h1>Engineer</h1><button disabled>Apply to this job</button></main>`);
    expect(selectActivationControl(document)).toBeNull();
  });

  it("refuses an aria-disabled Apply control", () => {
    mount(`<main><h1>Engineer</h1><button aria-disabled="true">Apply to this job</button></main>`);
    expect(selectActivationControl(document)).toBeNull();
  });

  it("never returns a submit control even when it is the only Apply-ish thing", () => {
    mount(`<main><h1>Engineer</h1><button>Submit your application now</button></main>`);
    expect(findActivationCandidates(document)).toEqual([]);
  });
});

describe("cookie and consent overlays", () => {
  it("detects a fixed consent banner", () => {
    mount(`<div class="cookie-consent" style="position:fixed;width:900px;height:200px">Cookies</div>`);
    expect(hasConsentOverlay(document)).toBe(true);
  });

  it("does not treat a small inline note as an overlay", () => {
    mount(`<div class="cookie-note" style="position:static;width:100px;height:20px">Cookies</div>`);
    expect(hasConsentOverlay(document)).toBe(false);
  });

  it("offers a reject action when the banner has one", () => {
    mount(`
      <div id="cookie-banner" style="position:fixed;width:900px;height:180px">
        <button>Accept all</button><button>Reject non-essential</button>
      </div>`);
    const control = findSafeConsentDismissal(document);
    expect(control?.textContent).toBe("Reject non-essential");
  });

  it.each(["Only essential cookies", "Continue without accepting", "Decline all"])(
    "recognises %s as a safe dismissal",
    (label) => {
      mount(`<div id="cookie" style="position:fixed;width:900px;height:180px"><button>${label}</button></div>`);
      expect(findSafeConsentDismissal(document)?.textContent).toBe(label);
    }
  );

  it("never offers an accept-all action as a dismissal", () => {
    mount(`
      <div id="cookie-banner" style="position:fixed;width:900px;height:180px">
        <button>Accept all cookies</button><button>I agree</button><button>Allow all</button>
      </div>`);
    expect(findSafeConsentDismissal(document)).toBeNull();
  });
});

describe("employer authentication pages", () => {
  const LOGIN = `
    <main>
      <h1>Sign in</h1>
      <form>
        <input type="email" name="email" />
        <input type="password" name="password" />
        <button type="submit">Sign in</button>
      </form>
      <a href="/forgot">Forgot your password?</a>
    </main>`;

  it("is recognised as an auth page", () => {
    mount(LOGIN);
    expect(isEmployerAuthPage(document)).toBe(true);
    expect(classifyPage(document).state).toBe("employer_auth_required");
  });

  it("does not misread a long application containing a password as a login page", () => {
    mount(`
      <main>
        <h1>Create your application</h1>
        <form id="application">
          <input name="first_name" /><input name="last_name" /><input name="email" />
          <input name="phone" /><input name="address" /><input name="city" />
          <input name="linkedin" /><input name="website" /><input name="referral" />
          <input type="password" name="account_password" />
          <textarea name="cover_letter"></textarea>
        </form>
      </main>`);
    expect(isEmployerAuthPage(document)).toBe(false);
  });

  it("is not an auth page without a password field", () => {
    mount(`<main><h1>Sign in</h1><a href="/login">Sign in</a></main>`);
    expect(isEmployerAuthPage(document)).toBe(false);
  });

  it("never proposes clicking the sign-in button as an application CTA", () => {
    mount(LOGIN);
    expect(selectActivationControl(document)).toBeNull();
  });
});

describe("page classification drives the retry decision", () => {
  it("reports a bare listing with no safe CTA as listing_page", () => {
    mount(`<main><h1>Engineer</h1><p>Great role.</p></main>`);
    expect(classifyPage(document).state).toBe("listing_page");
  });

  it("reports a page with controls but no resolved root as still loading", () => {
    mount(`<main><h1>Engineer</h1><input name="q" placeholder="Search" /></main>`);
    expect(classifyPage(document).state).toBe("application_form_loading");
  });

  it("reports a real application form as ready", () => {
    mount(`
      <main>
        <form action="/applications/submit">
          <label for="fn">First name</label><input id="fn" name="first_name" />
          <label for="ln">Last name</label><input id="ln" name="last_name" />
          <label for="em">Email</label><input id="em" name="email" type="email" />
          <label for="ph">Phone</label><input id="ph" name="phone" />
          <label for="rs">Resume</label><input id="rs" name="resume" type="file" />
          <button type="submit">Submit application</button>
        </form>
      </main>`);
    expect(classifyPage(document).state).toBe("application_form_ready");
  });
});
