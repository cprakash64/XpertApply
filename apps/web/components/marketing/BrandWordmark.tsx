import { PRODUCT_NAME } from "@/lib/siteConfig";
import Image from "next/image";

/**
 * The XpertApply wordmark.
 *
 * The two halves are ALWAYS two colours — "Xpert" in the primary navy, "Apply"
 * in the primary cyan. Rendering the name in a single colour is the one thing
 * this component exists to prevent, which is why no caller is given a way to do
 * it; `invert` only swaps the navy half to white for the dark trust section.
 *
 * The reference pairs its image mark with a two-colour text wordmark. The image
 * is the source asset embedded in the supplied design HTML.
 */
export function BrandWordmark({
  invert = false,
  className = ""
}: {
  invert?: boolean;
  className?: string;
}) {
  return (
    <span className={`xa-wordmark ${invert ? "xa-wordmark--invert" : ""} ${className}`}>
      {/* One accessible string, two visual halves: a screen reader hears
        * "XpertApply", never "Xpert Apply". */}
      <span className="sr-only">{PRODUCT_NAME}</span>
      <Image aria-hidden src="/brand/xpertapply-logo.png" alt="" width={34} height={34} unoptimized />
      <span aria-hidden>
        <span className="xa-wordmark__xpert">Xpert</span>
        <span className="xa-wordmark__apply">Apply</span>
      </span>
    </span>
  );
}
