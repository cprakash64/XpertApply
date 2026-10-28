import { BrandLogo } from "@/components/BrandLogo";

/**
 * The XpertApply wordmark as the marketing page uses it: the shared logo
 * (see BrandLogo) at navbar scale. The marketing stylesheet sizes it through
 * the `xa-wordmark` hook.
 */
export function BrandWordmark({ className = "" }: { className?: string }) {
  return <BrandLogo size={40} className={`xa-wordmark ${className}`} />;
}
