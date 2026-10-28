import { BRAND, PRODUCT_NAME } from "@/lib/siteConfig";

/**
 * The XpertApply identity, in one place.
 *
 * Before this component the mark was a lucide `BriefcaseBusiness` glyph pasted
 * into four different files, each with its own tile size, radius and colour
 * pairing — so "change the logo" meant finding all four and hoping. Everything
 * that draws the brand now renders `BrandLogo`, and the wordmark, the mark, and
 * the accessible name are defined exactly once.
 *
 * The mark is an "X" whose ascending stroke resolves into an arrowhead: the
 * initial of Xpert and the upward motion of a career, in one figure. It is drawn
 * in `currentColor` with the descending stroke held back by opacity, so a single
 * path set works on a light tile, a dark tile, and an accent-filled tile without
 * a second asset or a gradient.
 */

type Size = "sm" | "md" | "lg";

/**
 * `tone` decides how the logo relates to what is behind it.
 *
 * - `brand` — the default. An accent-tinted tile with an accent mark, sitting on
 *   a page surface.
 * - `solid` — a filled accent tile with a knocked-out mark. For places that need
 *   the logo to carry more weight than the surface around it.
 * - `inherit` — no tile, everything in `currentColor`. For a coloured or image
 *   background where the parent already owns the contrast decision.
 */
type Tone = "brand" | "solid" | "inherit";

const TILE: Record<Size, string> = {
  sm: "h-7 w-7 rounded-lg",
  md: "h-8 w-8 rounded-lg",
  lg: "h-10 w-10 rounded-xl"
};

const GLYPH: Record<Size, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5"
};

const WORD: Record<Size, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg"
};

const TONE: Record<Tone, string> = {
  brand: "bg-[var(--accent-surface)] text-[var(--accent)]",
  solid: "bg-[var(--accent)] text-[var(--accent-foreground)]",
  inherit: "text-current"
};

/**
 * The mark on its own — no tile, no wordmark.
 *
 * Exported for the rare caller that needs the glyph inside its own container
 * (a favicon route, a hero illustration). Everything else should use
 * `BrandLogo`, which pairs it with the tile and the name.
 */
export function BrandMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable="false"
    >
      {/* The descending stroke. Held back so the rising stroke reads as the
        * subject of the mark rather than one half of a symmetrical X. */}
      <path d="M6.5 6.5 18 18" opacity={0.38} />
      {/* The rising stroke, and its arrowhead. */}
      <path d="M6.5 18 18 6.5" />
      <path d="M12.75 6.5H18v5.25" />
    </svg>
  );
}

/**
 * The wordmark.
 *
 * "Xpert" and "Apply" are two spans so the name can carry a weight and colour
 * shift at the seam — the treatment that makes it a wordmark rather than a
 * label in the body font. They are deliberately adjacent with no whitespace
 * between them, so `textContent` is exactly "XpertApply" and the name reads as
 * one word to a screen reader, a copy-paste, and a text query alike.
 */
export function BrandWordmark({
  size = "md",
  tone = "brand",
  className = ""
}: {
  size?: Size;
  tone?: Tone;
  className?: string;
}) {
  const [first, second] = splitName();
  return (
    <span className={`font-semibold tracking-[-0.02em] ${WORD[size]} ${className}`}>
      <span>{first}</span>
      {/* On `inherit` the parent owns the colour, so the seam is weight only —
        * a second colour there could land at any contrast ratio. */}
      <span className={tone === "inherit" ? "font-bold" : "font-bold text-[var(--accent)]"}>
        {second}
      </span>
    </span>
  );
}

/**
 * Mark plus wordmark — the logo as used in navigation, footers and dialogs.
 *
 * `markOnly` keeps the accessible name intact while hiding the word, which is
 * what the collapsed sidebar rail needs: the name must still reach assistive
 * technology even when there is no room to draw it.
 */
export function BrandLogo({
  size = "md",
  tone = "brand",
  markOnly = false,
  className = ""
}: {
  size?: Size;
  tone?: Tone;
  markOnly?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        aria-hidden
        className={`grid shrink-0 place-items-center ${TILE[size]} ${TONE[tone]}`}
      >
        <BrandMark className={GLYPH[size]} />
      </span>
      {markOnly ? (
        <span className="sr-only">{PRODUCT_NAME}</span>
      ) : (
        <BrandWordmark size={size} tone={tone} />
      )}
    </span>
  );
}

/**
 * The accessible name for a link that points home.
 *
 * A helper rather than a literal in five files, so the home link is labelled
 * identically everywhere and the label follows a future rename automatically.
 */
export const BRAND_HOME_LABEL = `${PRODUCT_NAME} home`;

/** Splits the product name at its internal capital, e.g. XpertApply → Xpert|Apply. */
function splitName(): [string, string] {
  const seam = BRAND.name.search(/(?!^)[A-Z]/);
  return seam === -1
    ? [BRAND.name, ""]
    : [BRAND.name.slice(0, seam), BRAND.name.slice(seam)];
}
