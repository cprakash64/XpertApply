import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileWizard } from "@/components/ProfileWizard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shows saved and pending separately without resubmitting profile intake", async () => {
  const writes: string[] = [];
  const profile = { first_name: "Synthetic", last_name: "Candidate", full_name: "Synthetic Candidate",
    location_country: "United States", target_roles: ["Engineer"], skills: ["Python"],
    target_levels: [], preferred_locations: [], additional_links: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "PUT") writes.push(url);
    const body = url.endsWith("/auth/me") ? { email: "synthetic@example.test" }
      : url.endsWith("/profile/career") ? { education: [], experience: [], projects: [], certifications: [], awards: [], publications: [] }
      : { profile, ...(init?.method === "PUT" && url.endsWith("/profile")
          ? { processing: { enabled: true, accepted: true, status: "pending", intent_id: 1 } } : {}) };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  render(<ProfileWizard />);
  await userEvent.click(screen.getByRole("button", { name: "2. Basic info" }));
  await screen.findByDisplayValue("Synthetic");
  await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(screen.getByText("Profile saved.")).toBeInTheDocument());
  expect(screen.getByText("Fit scoring is processing. Your saved changes are accepted.")).toBeInTheDocument();
  expect(screen.queryByText("Fit scoring complete.")).not.toBeInTheDocument();
  expect(writes.filter(url => url.endsWith("/profile"))).toHaveLength(1);
});
