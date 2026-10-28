import type { Metadata } from "next";
import { PublicPage } from "@/components/PublicPage";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export const metadata: Metadata = {
  title: "Pricing",
  description: "How XpertApply is offered today, and what is still to be decided about hosted pricing.",
  alternates: { canonical: "/pricing" }
};

export default function PricingPage() {
  return (
    <PublicPage
      title="Pricing"
      width="max-w-4xl"
      intro="The open-source MVP is free to run locally. Hosted pricing is intentionally a placeholder until deployment costs, AI usage controls, and privacy commitments are finalized."
    />
  );
}
