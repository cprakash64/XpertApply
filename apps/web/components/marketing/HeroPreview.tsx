import { Check, FileText, MapPin } from "lucide-react";

/**
 * The hero's product picture: the discover-to-prepare moment, drawn with the
 * product's own vocabulary (job rows, a prepare panel, a review step).
 *
 * Everything in it is illustrative and says so in the caption. There are no
 * company names, scores, counts or percentages, because none of it is data. The
 * picture is decorative for assistive technology: the figure carries one
 * sentence describing it, and the rows inside are hidden from the tree so a
 * screen reader never reads placeholder jobs as if they were results.
 */
const ROLES = [
  { title: "Product Designer", meta: "Example company · Remote", active: true },
  { title: "Data Analyst", meta: "Example company · Hybrid", active: false },
  {
    title: "Customer Success Manager",
    meta: "Example company · On-site",
    active: false,
  },
];

const STEPS = [
  "Résumé tailored to the role",
  "Cover letter drafted",
  "Form fields filled in your browser",
];

export function HeroPreview() {
  return (
    <figure
      className="xa-heroview"
      aria-label="Illustration: a recommended job selected, with a tailored résumé and cover letter ready to review before you submit."
    >
      <div className="xa-heroview__surface">
        <div className="xa-heroview__card" aria-hidden>
          <div className="xa-heroview__list">
            <div className="xa-heroview__head">
              <span>Recommended for you</span>
              <strong>Jobs worth your time</strong>
            </div>
            <ul>
              {ROLES.map((role) => (
                <li key={role.title} data-active={role.active}>
                  <span className="xa-heroview__logo" />
                  <span>
                    <b>{role.title}</b>
                    <small>
                      <MapPin />
                      {role.meta}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="xa-heroview__panel">
            <span className="xa-heroview__tag">
              <FileText /> Prepare application
            </span>
            <strong>Ready for your review</strong>
            <ul>
              {STEPS.map((step) => (
                <li key={step}>
                  <Check />
                  {step}
                </li>
              ))}
            </ul>
            <span className="xa-heroview__submit">You review and submit</span>
          </div>
        </div>
      </div>
      <figcaption>Illustrative example. Not real jobs or data.</figcaption>
    </figure>
  );
}
