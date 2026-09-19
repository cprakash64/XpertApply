import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPage from "../app/privacy/page";
import { MarketingFooter } from "../components/marketing/MarketingFooter";

afterEach(cleanup);

describe("public privacy policy", () => {
  it("renders without account state and explains collection, recipients, retention, and controls", () => {
    render(React.createElement(PrivacyPage));
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeInTheDocument();
    for (const heading of ["Scope and purpose", "Information you provide", "Application pages and browser activity", "Extension storage", "How information is used and shared", "Retention and deletion", "Your controls and security", "Chrome Web Store Limited Use", "Changes and contact"]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    for (const recipient of ["OpenAI", "People Data Labs", "Apollo", "Hunter", "Hostinger"]) {
      expect(screen.getAllByText(recipient, { exact: true }).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/relevant page and form information/)).toBeInTheDocument();
    expect(screen.getByText(/seven-day grace period/)).toBeInTheDocument();
    expect(screen.getByText(/Chrome Web Store User Data Policy/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy@xpertapply.com" })).toHaveAttribute("href", "mailto:privacy@xpertapply.com");
    expect(document.body.textContent).not.toMatch(/\b(?:TODO|placeholder)\b/i);
  });

  it("keeps the homepage footer privacy route and labels the mailbox accurately", () => {
    render(React.createElement(MarketingFooter));
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Privacy contact" })).toHaveAttribute("href", "mailto:privacy@xpertapply.com");
  });
});
