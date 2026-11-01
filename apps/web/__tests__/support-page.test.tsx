import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SupportPage from "@/app/support/page";
import sitemap from "@/app/sitemap";

describe("support page", () => {
  it("renders a contact and the privacy link, and is in the sitemap", () => {
    render(<SupportPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Support" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy@xpertapply.com" })).toHaveAttribute("href", "mailto:privacy@xpertapply.com");
    expect(screen.getAllByRole("link", { name: /privacy policy/i })[0]).toHaveAttribute("href", "/privacy");
    expect(sitemap().some((e) => e.url.endsWith("/support"))).toBe(true);
  });
});
