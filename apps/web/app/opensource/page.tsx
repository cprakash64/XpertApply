import type { Metadata } from "next";
import { PublicPage } from "@/components/PublicPage";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export const metadata: Metadata = {
  title: "Open source",
  description:
    "XpertApply is built as a Next.js frontend and FastAPI backend with shared schemas, Docker Compose infrastructure and CI, under the MIT License.",
  alternates: { canonical: "/opensource" }
};

export default function OpenSourcePage() {
  return (
    <PublicPage
      title="Open source"
      width="max-w-4xl"
      intro="The repository is structured as a Next.js frontend, FastAPI backend, shared schemas, Docker Compose infrastructure, CI, and contributor documentation under the MIT License."
    />
  );
}
