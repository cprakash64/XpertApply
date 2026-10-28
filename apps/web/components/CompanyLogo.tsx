"use client";

import { useMemo, useState } from "react";
import { API_URL } from "@/lib/api";

/**
 * Company logo with a real fallback chain: try the primary (proxied,
 * cached, SSRF-safe) source first, then a secondary direct source if the
 * first fails, and fall back to a deterministic generated company mark once
 * every real source has failed. That guarantees every card has a recognizable
 * visual identity without pretending an unverified domain belongs to a
 * company. The logo area is fixed so the layout never shifts.
 */
export function CompanyLogo({
  company,
  logoUrl,
  proxyPath,
  companyDomain: _companyDomain,
  size = 44
}: {
  company: string;
  logoUrl?: string | null;
  /** Relative API path for the preferred (proxied) source, e.g.
   * "/jobs/companies/acme/logo". */
  proxyPath?: string | null;
  companyDomain?: string | null;
  size?: number;
}) {
  const sources = useMemo(() => {
    const list: string[] = [];
    if (proxyPath) list.push(`${API_URL}${proxyPath}`);
    if (isTrustedLogoUrl(logoUrl)) list.push(logoUrl);
    return list;
  }, [proxyPath, logoUrl]);

  const [attempt, setAttempt] = useState(0);
  const src = sources[attempt];

  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-card border border-line-default"
      // VENDOR IDENTITY EXCEPTION. The app supports a dark theme and some
      // company favicons (RTX is one) are black-on-transparent. Pin the logo
      // canvas to real white so a valid image never looks like an empty dark
      // square. This inline value is the single source of truth for the tile —
      // no theme token belongs here.
      style={{ width: size, height: size, backgroundColor: "#ffffff" }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- external/proxied logo host; next/image would require per-domain config + CSP allowances
        <img
          key={src}
          src={src}
          alt={`${company} logo`}
          width={size}
          height={size}
          loading="lazy"
          className="h-full w-full object-contain p-1"
          onError={() => setAttempt((a) => a + 1)}
        />
      ) : (
        <GeneratedCompanyMark company={company} size={size} />
      )}
    </div>
  );
}

function isTrustedLogoUrl(value?: string | null): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      !(
        parsed.hostname === "storage.googleapis.com" &&
        parsed.pathname.startsWith("/simplify-imgs/")
      );
  } catch {
    return false;
  }
}

/*
 * The generated mark is XpertApply's own placeholder, not a third-party logo, so
 * it uses the product palette: one quiet ice-blue tile with slate initials. The
 * old per-company hash picked from six hues (including green and brown), which
 * made an arbitrary colour look like a signal.
 */
function GeneratedCompanyMark({ company, size }: { company: string; size: number }) {
  const words = company
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || "JP").toUpperCase();

  return (
    <span
      data-testid="company-logo-generated"
      role="img"
      aria-label={`${company} generated company mark`}
      className="flex h-full w-full items-center justify-center bg-surface-selected font-bold tracking-[-0.04em] text-brand-primary"
      style={{ fontSize: Math.max(11, Math.round(size * 0.33)) }}
    >
      {initials}
    </span>
  );
}
