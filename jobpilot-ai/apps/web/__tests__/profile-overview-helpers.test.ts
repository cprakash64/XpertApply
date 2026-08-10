import { describe, expect, it } from "vitest";
import { emptyProfile, type ProfileForm } from "@/lib/profileForm";
import {
  displayName,
  formatDateRange,
  locationLabel,
  needsOnboarding,
  profileInitials,
  type ProfileOverviewData
} from "@/lib/profileOverview";

function profile(overrides: Partial<ProfileForm> = {}): ProfileForm {
  return { ...emptyProfile, ...overrides };
}

function overview(overrides: Partial<ProfileOverviewData> = {}): ProfileOverviewData {
  return {
    profile: profile(),
    isNewProfile: false,
    education: [],
    experience: [],
    projects: [],
    certifications: [],
    awards: [],
    publications: [],
    eligibility: [],
    completeness: {
      completion: { percent: 0, satisfied: [], missing: [] },
      autofillReadiness: { percent: 0, satisfied: [], missing: [] }
    },
    ...overrides
  };
}

describe("profileInitials", () => {
  it("uses the given and family name", () => {
    expect(profileInitials(profile({ first_name: "Chandra", last_name: "Pandey" }))).toBe("CP");
  });

  it("keeps both initials when only a preferred FIRST name is set", () => {
    // Regression: a preferred-first-name-only profile previously fell through
    // to the surname alone and rendered a single-name initial pair.
    expect(
      profileInitials(
        profile({ preferred_first_name: "Chan", first_name: "Chandra", last_name: "Pandey" })
      )
    ).toBe("CP");
  });

  it("keeps both initials when only a preferred LAST name is set", () => {
    expect(
      profileInitials(profile({ first_name: "Chandra", preferred_last_name: "P." }))
    ).toBe("CP");
  });

  it("falls back to full_name for a legacy profile with no structured parts", () => {
    expect(profileInitials(profile({ full_name: "Chandra Pandey" }))).toBe("CP");
  });

  it("uses two letters of a single name", () => {
    expect(profileInitials(profile({ first_name: "Chandra" }))).toBe("CH");
  });

  it("returns a placeholder rather than crashing on an empty profile", () => {
    expect(profileInitials(profile())).toBe("?");
  });
});

describe("displayName", () => {
  it("prefers what the user asked to be called", () => {
    expect(
      displayName(profile({ preferred_first_name: "Chan", first_name: "Chandra", last_name: "Pandey" }))
    ).toBe("Chan Pandey");
  });

  it("does not drop the given name when only a preferred surname is set", () => {
    expect(displayName(profile({ first_name: "Chandra", preferred_last_name: "P." }))).toBe(
      "Chandra P."
    );
  });

  it("falls back to full_name", () => {
    expect(displayName(profile({ full_name: "Chandra Pandey" }))).toBe("Chandra Pandey");
  });

  it("is empty for an empty profile", () => {
    expect(displayName(profile())).toBe("");
  });
});

describe("locationLabel", () => {
  it("prefers state over country", () => {
    expect(
      locationLabel(profile({ location_city: "Phoenix", location_state: "AZ", location_country: "United States" }))
    ).toBe("Phoenix, AZ");
  });

  it("uses country when there is no state", () => {
    expect(
      locationLabel(profile({ location_city: "Berlin", location_state: "", location_country: "Germany" }))
    ).toBe("Berlin, Germany");
  });

  it("omits missing parts rather than leaving a dangling comma", () => {
    expect(locationLabel(profile({ location_city: "Phoenix", location_state: "", location_country: "" }))).toBe(
      "Phoenix"
    );
  });
});

describe("formatDateRange", () => {
  it("formats a closed range", () => {
    expect(formatDateRange("2019-08", "2023-05")).toBe("Aug 2019 — May 2023");
  });

  it("renders an ongoing role as Present", () => {
    expect(formatDateRange("2023-06", "", true)).toBe("Jun 2023 — Present");
  });

  it("tolerates a full ISO date", () => {
    expect(formatDateRange("2019-08-15", "2023-05-01")).toBe("Aug 2019 — May 2023");
  });

  it("passes through a value it cannot parse rather than guessing", () => {
    expect(formatDateRange("Summer 2021", "")).toBe("Summer 2021");
  });

  it("is empty when there are no dates", () => {
    expect(formatDateRange("", "")).toBe("");
  });
});

describe("needsOnboarding", () => {
  it("is true for an account with no profile record", () => {
    expect(needsOnboarding(overview({ isNewProfile: true }))).toBe(true);
  });

  it("is true for a profile row with nothing meaningful in it", () => {
    expect(needsOnboarding(overview())).toBe(true);
  });

  it("is false once the user has a name", () => {
    expect(needsOnboarding(overview({ profile: profile({ first_name: "Chandra" }) }))).toBe(false);
  });

  it("is false once there is any career history, even without a name", () => {
    expect(
      needsOnboarding(
        overview({
          experience: [
            {
              company: "Acme",
              title: "Engineer",
              location: "",
              start_date: "",
              end_date: "",
              currently_working: false,
              technologies: []
            }
          ]
        })
      )
    ).toBe(false);
  });

  it("is false once the user has set targets or skills", () => {
    expect(needsOnboarding(overview({ profile: profile({ skills: ["Python"] }) }))).toBe(false);
  });
});
