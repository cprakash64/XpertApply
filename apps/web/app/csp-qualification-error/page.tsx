import { headers } from "next/headers";
export default async function QualificationErrorPage() {
  if ((await headers()).get("x-csp-qual-segment-error") === "1") throw new Error("CSP_QUAL_PAGE_ERROR");
  return <h1>Qualification segment recovered</h1>;
}
