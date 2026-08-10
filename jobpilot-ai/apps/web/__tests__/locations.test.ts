import { describe, expect, it } from "vitest";
import {
  countryNames,
  interpretStoredLocations,
  isLegacyRemoteLocation,
  searchLocations
} from "@/lib/locations";
import { emptyProfile, normalizeProfile } from "@/lib/profileForm";

describe("countryNames", () => {
  it("covers the whole world, not a curated shortlist", () => {
    const names = countryNames();
    // ~250 ISO 3166-1 entries; a hardcoded "top 20" would fail this.
    expect(names.length).toBeGreaterThan(200);
  });

  it("includes countries from every inhabited continent", () => {
    const names = countryNames();
    for (const country of [
      "United States", "United Kingdom", "Germany", "India", "Japan",
      "Australia", "Brazil", "Nigeria", "Canada", "Singapore"
    ]) {
      expect(names, `${country} should be selectable`).toContain(country);
    }
  });

  it("is sorted and free of duplicates", () => {
    const names = countryNames();
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe("searchLocations", () => {
  it("finds countries by prefix", () => {
    const values = searchLocations("Germ").map((item) => item.value);
    expect(values).toContain("Germany");
  });

  it("finds non-US cities", () => {
    for (const [query, expected] of [
      ["Bengal", "Bengaluru, India"],
      ["London", "London, United Kingdom"],
      ["Berlin", "Berlin, Germany"],
      ["Sydney", "Sydney, Australia"],
      ["Amsterd", "Amsterdam, Netherlands"],
      ["Dubai", "Dubai, United Arab Emirates"],
      ["Toronto", "Toronto, Canada"]
    ] as const) {
      expect(searchLocations(query).map((item) => item.value)).toContain(expected);
    }
  });

  it("still finds US locations, so existing users are not regressed", () => {
    expect(searchLocations("Phoenix").map((item) => item.value)).toContain(
      "Phoenix, AZ, United States"
    );
    expect(searchLocations("United States").map((item) => item.value)).toContain("United States");
  });

  it("is accent-insensitive", () => {
    expect(searchLocations("sao paulo").map((item) => item.value)).toContain("São Paulo, Brazil");
    expect(searchLocations("Krakow").map((item) => item.value)).toContain("Kraków, Poland");
  });

  it("ranks prefix matches ahead of substring matches", () => {
    const values = searchLocations("ind").map((item) => item.value);
    expect(values[0]).toBe("India");
  });

  it("always offers the raw query as a custom location", () => {
    const results = searchLocations("Ljubljana, Slovenia");
    const custom = results.find((item) => item.kind === "custom");
    expect(custom?.value).toBe("Ljubljana, Slovenia");
  });

  it("does not offer a custom entry that duplicates a real suggestion", () => {
    const results = searchLocations("Germany");
    expect(results.filter((item) => item.value === "Germany")).toHaveLength(1);
  });

  it("excludes values the user already selected", () => {
    const results = searchLocations("Germany", { exclude: ["Germany"] });
    expect(results.map((item) => item.value)).not.toContain("Germany");
  });

  it("leads with countries rather than US cities when there is no query", () => {
    const results = searchLocations("");
    expect(results.every((item) => item.kind === "country")).toBe(true);
  });

  it("never offers Remote as a location", () => {
    // Remote is a workplace preference, not a place.
    const values = searchLocations("Remote").map((item) => item.value);
    expect(values.filter((value) => value.toLowerCase() === "remote")).toEqual(["Remote"]);
    // ...and only as the free-text custom entry, never as a known suggestion.
    const known = searchLocations("Remote").filter((item) => item.kind !== "custom");
    expect(known.map((item) => item.value.toLowerCase())).not.toContain("remote");
  });
});

describe("isLegacyRemoteLocation", () => {
  it("recognizes the tokens older profiles stored", () => {
    for (const token of ["Remote", "remote", "Remote (US)", "Fully remote", "Anywhere", "WFH"]) {
      expect(isLegacyRemoteLocation(token), token).toBe(true);
    }
  });

  it("does not swallow real places that merely contain the word", () => {
    for (const place of ["Remote, Oregon", "Remoteness Bay, Australia", "Berlin, Germany"]) {
      expect(isLegacyRemoteLocation(place), place).toBe(false);
    }
  });
});

describe("interpretStoredLocations", () => {
  it("leaves a modern profile untouched", () => {
    const result = interpretStoredLocations(["Berlin, Germany"], "hybrid");
    expect(result).toEqual({ locations: ["Berlin, Germany"], workplace: "hybrid", migrated: false });
  });

  it("moves a legacy Remote location into the workplace preference", () => {
    const result = interpretStoredLocations(["Remote", "London, United Kingdom"], "everything");
    expect(result.locations).toEqual(["London, United Kingdom"]);
    expect(result.workplace).toBe("remote");
    expect(result.migrated).toBe(true);
  });

  it("never overrides an explicitly chosen workplace", () => {
    // The user said On-site; an ambiguous legacy token must not undo that.
    const result = interpretStoredLocations(["Remote"], "onsite");
    expect(result.workplace).toBe("onsite");
    // The token still leaves the location list — it is not a place.
    expect(result.locations).toEqual([]);
    expect(result.migrated).toBe(true);
  });

  it("keeps an explicit remote choice as remote", () => {
    expect(interpretStoredLocations(["Remote"], "remote").workplace).toBe("remote");
  });
});

describe("normalizeProfile location handling", () => {
  it("applies the interpretation at the single wire boundary", () => {
    const form = normalizeProfile({
      preferred_locations: ["Remote", "Bengaluru, India"],
      work_preference: "everything"
    });
    expect(form.preferred_locations).toEqual(["Bengaluru, India"]);
    expect(form.remote_preference).toBe("remote");
  });

  it("preserves existing US locations exactly as stored", () => {
    const form = normalizeProfile({
      preferred_locations: ["Phoenix, AZ", "San Francisco, CA"],
      work_preference: "hybrid"
    });
    expect(form.preferred_locations).toEqual(["Phoenix, AZ", "San Francisco, CA"]);
    expect(form.remote_preference).toBe("hybrid");
  });

  it("defaults cleanly for a profile with no locations", () => {
    expect(normalizeProfile({}).preferred_locations).toEqual([]);
    expect(normalizeProfile({}).remote_preference).toBe(emptyProfile.remote_preference);
  });
});
