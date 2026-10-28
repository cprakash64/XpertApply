import { publicViewport } from "@/lib/publicViewport";

/** The Google callback is a public page, so it is always light (the page itself is a client component). */
export const viewport = publicViewport;

export default function GoogleCallbackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
