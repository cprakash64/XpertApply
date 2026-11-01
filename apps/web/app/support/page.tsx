import type { Metadata } from "next";
import { PublicPage } from "@/components/PublicPage";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export const metadata: Metadata = {
  title: "Support",
  description: "Help with the XpertApply web app and Chrome extension.",
  alternates: { canonical: "/support" }
};

export default function SupportPage() {
  return (
    <PublicPage title="Support" intro="Help with the XpertApply web app and Chrome extension.">
      <article className="mt-8 space-y-8 leading-7 [&_h2]:mb-3 [&_h2]:text-2xl [&_h2]:font-semibold [&_p+p]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        <section aria-labelledby="contact">
          <h2 id="contact">Contact us</h2>
          <p>
            Email <a className="underline" href="mailto:privacy@xpertapply.com">privacy@xpertapply.com</a> for questions about your account, the
            extension, or your data. Please do not include passwords or sensitive personal details in the message.
          </p>
        </section>
        <section aria-labelledby="extension">
          <h2 id="extension">Using the extension</h2>
          <ul>
            <li>Sign in to XpertApply on this site, then use Connect in the extension to link it to your account.</li>
            <li>On a supported application page, open the extension to review the suggested answers. You always review and submit the application yourself.</li>
            <li>To disconnect, sign out of XpertApply or use the extension&apos;s disconnect option. Signing out ends the extension&apos;s access to your account.</li>
          </ul>
        </section>
        <section aria-labelledby="privacy">
          <h2 id="privacy">Privacy and your data</h2>
          <p>
            See the <a className="underline" href="/privacy">privacy policy</a> for what the web app and extension handle and how to request deletion.
          </p>
        </section>
      </article>
    </PublicPage>
  );
}
