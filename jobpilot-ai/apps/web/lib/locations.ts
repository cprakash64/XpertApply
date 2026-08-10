/**
 * Global location vocabulary for job preferences.
 *
 * JobPilot is not a US product, but the location picker used to offer fifteen
 * hardcoded American cities, which made every non-US user type their own
 * country by hand. This module replaces that list with a genuinely global one
 * without adding a dependency:
 *
 * * **Countries** come from the ISO 3166-1 alpha-2 code list below (the codes
 *   are stable and small) rendered through `Intl.DisplayNames`, which every
 *   supported runtime already ships. That gives all ~250 countries and
 *   territories, named in the user's own locale, for zero bundle cost beyond
 *   the codes themselves.
 * * **Cities** are a curated set of major hiring markets spread across every
 *   inhabited continent. They are *suggestions* to make search feel alive —
 *   never a restriction. Anything the user types is accepted.
 *
 * Nothing here normalizes or rewrites a stored value. A profile that already
 * says "Phoenix, AZ" keeps saying exactly that; the picker simply also knows
 * about Bengaluru and Kraków now.
 */

/** ISO 3166-1 alpha-2. The source of truth for "which countries exist". */
const COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS",
  "BT","BW","BY","BZ","CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO",
  "CR","CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM","DO","DZ","EC","EE","EG",
  "EH","ER","ES","ET","FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG",
  "GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY","HK","HN","HR",
  "HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK",
  "LR","LS","LT","LU","LV","LY","MA","MC","MD","ME","MF","MG","MH","MK","ML","MM",
  "MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA","NC","NE",
  "NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM","PA","PE","PF","PG","PH","PK",
  "PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW","SA","SB",
  "SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV",
  "SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT",
  "TV","TW","TZ","UA","UG","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF",
  "WS","YE","YT","ZA","ZM","ZW"
] as const;

/**
 * Major hiring markets, deliberately spread worldwide.
 *
 * This is a convenience layer, not a whitelist — `searchLocations` always
 * offers the raw query as a custom option, so a user in Ljubljana or Kigali is
 * never blocked by an omission here.
 */
const MAJOR_CITIES = [
  // Africa
  "Cairo, Egypt", "Lagos, Nigeria", "Nairobi, Kenya", "Cape Town, South Africa",
  "Johannesburg, South Africa", "Casablanca, Morocco", "Accra, Ghana",
  // Americas
  "New York, NY, United States", "San Francisco, CA, United States",
  "Seattle, WA, United States", "Austin, TX, United States",
  "Boston, MA, United States", "Chicago, IL, United States",
  "Los Angeles, CA, United States", "Denver, CO, United States",
  "Atlanta, GA, United States", "Phoenix, AZ, United States",
  "Washington, DC, United States", "Toronto, Canada", "Vancouver, Canada",
  "Montreal, Canada", "Mexico City, Mexico", "São Paulo, Brazil",
  "Rio de Janeiro, Brazil", "Buenos Aires, Argentina", "Santiago, Chile",
  "Bogotá, Colombia", "Lima, Peru",
  // Asia
  "Bengaluru, India", "Hyderabad, India", "Mumbai, India", "Delhi, India",
  "Pune, India", "Chennai, India", "Singapore", "Tokyo, Japan", "Osaka, Japan",
  "Seoul, South Korea", "Shanghai, China", "Beijing, China", "Shenzhen, China",
  "Hong Kong", "Taipei, Taiwan", "Bangkok, Thailand", "Jakarta, Indonesia",
  "Kuala Lumpur, Malaysia", "Manila, Philippines", "Ho Chi Minh City, Vietnam",
  "Tel Aviv, Israel", "Dubai, United Arab Emirates", "Abu Dhabi, United Arab Emirates",
  "Riyadh, Saudi Arabia", "Doha, Qatar", "Istanbul, Türkiye", "Karachi, Pakistan",
  "Dhaka, Bangladesh", "Colombo, Sri Lanka",
  // Europe
  "London, United Kingdom", "Manchester, United Kingdom",
  "Edinburgh, United Kingdom", "Cambridge, United Kingdom",
  "Dublin, Ireland", "Berlin, Germany", "Munich, Germany", "Hamburg, Germany",
  "Frankfurt, Germany", "Amsterdam, Netherlands", "Rotterdam, Netherlands",
  "Paris, France", "Lyon, France", "Madrid, Spain", "Barcelona, Spain",
  "Lisbon, Portugal", "Milan, Italy", "Rome, Italy", "Zurich, Switzerland",
  "Geneva, Switzerland", "Vienna, Austria", "Brussels, Belgium",
  "Copenhagen, Denmark", "Stockholm, Sweden", "Oslo, Norway",
  "Helsinki, Finland", "Warsaw, Poland", "Kraków, Poland", "Prague, Czechia",
  "Budapest, Hungary", "Bucharest, Romania", "Athens, Greece",
  // Oceania
  "Sydney, Australia", "Melbourne, Australia", "Brisbane, Australia",
  "Perth, Australia", "Auckland, New Zealand", "Wellington, New Zealand"
];

export type LocationSuggestion = {
  /** The exact string that will be stored on the profile. */
  value: string;
  /** What kind of place this is, for the picker's grouping and iconography. */
  kind: "country" | "city" | "custom";
};

let cachedCountries: string[] | null = null;

/**
 * Every country name, localized.
 *
 * `Intl.DisplayNames` is available in all runtimes this app targets (and in
 * Node's ICU build used by the test suite). If it is ever missing, the raw code
 * is used rather than throwing — a degraded label beats a broken picker.
 */
export function countryNames(): string[] {
  if (cachedCountries) return cachedCountries;
  let display: Intl.DisplayNames | null = null;
  try {
    display = new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    display = null;
  }
  const names = COUNTRY_CODES.map((code) => {
    try {
      return display?.of(code) ?? code;
    } catch {
      return code;
    }
  });
  cachedCountries = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return cachedCountries;
}

/** Case- and accent-insensitive contains, so "sao paulo" finds "São Paulo". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Search countries and major cities, always offering the raw query too.
 *
 * Ordering puts prefix matches ahead of substring matches so typing "ind"
 * surfaces India before "West Indies"-style incidental hits. Already-selected
 * values are excluded so the picker never offers a duplicate.
 */
export function searchLocations(
  query: string,
  { exclude = [], limit = 12 }: { exclude?: string[]; limit?: number } = {}
): LocationSuggestion[] {
  const needle = fold(query);
  const taken = new Set(exclude.map(fold));

  const pool: LocationSuggestion[] = [
    ...countryNames().map((value) => ({ value, kind: "country" as const })),
    ...MAJOR_CITIES.map((value) => ({ value, kind: "city" as const }))
  ];

  const matches = needle
    ? pool
        .filter((item) => fold(item.value).includes(needle))
        .sort((a, b) => {
          const aStarts = fold(a.value).startsWith(needle) ? 0 : 1;
          const bStarts = fold(b.value).startsWith(needle) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return a.value.localeCompare(b.value);
        })
    : // With no query, lead with countries: a globally neutral starting point,
      // rather than a list of American cities.
      pool.filter((item) => item.kind === "country");

  const results = matches.filter((item) => !taken.has(fold(item.value))).slice(0, limit);

  // Anything the user types is a valid location. Offered last, and only when it
  // is not already an exact suggestion or an existing selection.
  const trimmed = query.trim();
  if (
    trimmed &&
    !taken.has(fold(trimmed)) &&
    !results.some((item) => fold(item.value) === fold(trimmed))
  ) {
    results.push({ value: trimmed, kind: "custom" });
  }
  return results;
}

/* ---------------------------------------------------------------------- */
/* Legacy "Remote" locations                                              */
/* ---------------------------------------------------------------------- */

/**
 * Tokens that older profiles stored in `preferred_locations` to mean "I want to
 * work remotely" — a *workplace* preference that was living in the *location*
 * field. Matching is exact-after-folding so a real place is never caught:
 * "Remote, Oregon" is a location and stays one.
 */
const REMOTE_TOKENS = new Set([
  "remote",
  "remote (us)",
  "remote us",
  "remote - us",
  "fully remote",
  "work from home",
  "wfh",
  "anywhere"
]);

/** True when a stored location is really a workplace preference in disguise. */
export function isLegacyRemoteLocation(value: string): boolean {
  return REMOTE_TOKENS.has(fold(value));
}

export type WorkplacePreference = "everything" | "remote" | "hybrid" | "onsite";

export type LocationInterpretation = {
  /** Locations with the legacy remote tokens removed. */
  locations: string[];
  /** The workplace preference to use. */
  workplace: WorkplacePreference;
  /** True when a legacy token was found and dropped from the location list. */
  migrated: boolean;
};

/**
 * Interpret a stored profile's locations and workplace together.
 *
 * The rule is conservative on purpose. A legacy "Remote" location only *implies*
 * a workplace when the user has not already expressed one — if they explicitly
 * chose Hybrid or On-site, that explicit choice wins and we do not silently
 * overwrite it from an ambiguous legacy token. Either way the token leaves the
 * location list, because "Remote" is not a place.
 *
 * This runs on read, so nothing is rewritten in the database until the user
 * saves the section themselves.
 */
export function interpretStoredLocations(
  locations: string[],
  workplace: WorkplacePreference
): LocationInterpretation {
  const legacy = locations.filter(isLegacyRemoteLocation);
  const cleaned = locations.filter((value) => !isLegacyRemoteLocation(value));

  if (legacy.length === 0) {
    return { locations: cleaned, workplace, migrated: false };
  }
  // "everything" is the default, i.e. the user never chose — so a legacy remote
  // token is the only signal available and is honoured. An explicit remote /
  // hybrid / onsite choice is left exactly as the user set it.
  const resolved: WorkplacePreference = workplace === "everything" ? "remote" : workplace;
  return { locations: cleaned, workplace: resolved, migrated: true };
}
