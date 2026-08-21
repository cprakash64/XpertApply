"use client";

import type { CoverLetterContent } from "@/lib/api";

/**
 * Renders the structured cover letter as a clean, one-page professional letter.
 *
 * The document BODY is a facsimile of printed paper and is deliberately fixed
 * in both themes: it has to match the DOCX/PDF the same content is exported to,
 * and a charcoal sheet would misrepresent what the employer receives. Only the
 * surrounding modal chrome follows the active theme. The `document-*` tokens
 * exist for exactly this and must not be used for product chrome.
 */
export function GeneratedCoverLetterPreview({ content }: { content: CoverLetterContent }) {
  return (
    <div className="mx-auto w-full max-w-[820px] bg-document-paper px-12 py-11 text-[13.5px] leading-7 text-document-ink shadow-sm ring-1 ring-black/5 print:shadow-none [font-family:Georgia,'Times_New_Roman',serif]">
      {content.date && <p>{content.date}</p>}

      <div className="mt-6">
        <p>{content.recipient || "Hiring Team"}</p>
        {content.company && <p>{content.company}</p>}
        {content.role && <p className="text-document-ink-muted">Re: {content.role}</p>}
      </div>

      <p className="mt-6">{content.greeting || "Dear Hiring Team,"}</p>

      <div className="mt-3 grid gap-3 text-justify">
        {(content.paragraphs ?? []).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>

      <div className="mt-6">
        <p>{content.closing || "Best regards,"}</p>
        <p className="mt-4 font-semibold">{content.signature}</p>
      </div>
    </div>
  );
}
