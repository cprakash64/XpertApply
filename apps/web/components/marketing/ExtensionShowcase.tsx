import { Check } from "lucide-react";
import { BrandWordmark } from "@/components/marketing/BrandWordmark";
import { ExtensionCta } from "@/components/marketing/ExtensionCta";

/**
 * The Chrome extension section.
 *
 * Deliberately short. Earlier versions of this section explained the extension
 * at length; the approved direction is three steps and a visual, on the
 * principle that a reader who has just watched the workflow story does not need
 * the mechanism spelled out again.
 *
 * The copy never claims the extension submits anything. Step 03 is the point of
 * the whole section.
 */
const STEPS = [
  { n: "01", title: "Install XpertApply", body: "Add the extension to Chrome and sign in." },
  {
    n: "02",
    title: "Open an application",
    body: "XpertApply detects fields and fills what it can from your profile."
  },
  {
    n: "03",
    title: "Review & submit",
    body: "Check the completed application before anything is sent."
  }
];

export function ExtensionShowcase() {
  return (
    <section id="extension" className="xa-ext" aria-labelledby="xa-ext-title">
      <div className="xa-shell">
        <div className="xa-ext__grid">
          <div>
            <div className="xa-section-head">
              <span className="xa-eyebrow">XpertApply for Chrome</span>
              <h2 id="xa-ext-title">
                <span>Stop filling out</span>
                <span>the same</span>
                <span>application over</span>
                <span>and over.</span>
              </h2>
              <p>
                Bring your saved profile into the application flow and move through repetitive
                fields faster — while you stay in control.
              </p>
            </div>

            <ol className="xa-ext__steps">
              {STEPS.map((step) => (
                <li key={step.n} className="xa-ext__step">
                  <span className="xa-ext__step-n">{step.n}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="xa-cta-row">
              <ExtensionCta id="extension-section-cta" />
            </div>
          </div>

          <ExtensionVisual />
        </div>
      </div>
    </section>
  );
}

/**
 * The extension in place on an employer's form.
 *
 * Self-contained on purpose: it takes no props, owns its own box, and nothing
 * outside it depends on its internals. Swapping this for a short screen
 * recording later means replacing the body of this one function — the section
 * around it, its grid, and its responsive behaviour all stay as they are.
 *
 * Marked `aria-hidden` and paired with a caption, because it is a picture of an
 * interface: reading twenty fragmentary field labels aloud would tell a screen
 * reader user less than the sentence underneath does.
 */
const PANEL_ROWS = [
  "Personal information",
  "Work authorization",
  "Education",
  "Experience",
  "Reusable answers"
];

function ExtensionVisual() {
  return (
    <figure style={{ margin: 0 }}>
      <div className="xa-ext__visual" aria-hidden>
        <div className="xa-ext__chrome">
          <span className="xa-mock__dots"><span /><span /><span /></span>
          <span className="xa-ext__url">company.jobs/application</span>
        </div>
        <div className="xa-ext__browser-body">
          <div className="xa-ext__form">
            <span className="xa-ext__skeleton xa-ext__skeleton--company" />
            <span className="xa-ext__skeleton xa-ext__skeleton--title" />
            <div className="xa-ext__fields">
              {[82, 64, 74, 68, 0].map((fill, index) => (
                <div key={index} className="xa-ext__field">
                  <span className="xa-ext__field-label" />
                  <span className="xa-ext__field-input">
                    {fill > 0 && <i style={{ width: `${fill}%` }} />}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <aside className="xa-ext__panel">
            <BrandWordmark />
            <div className="xa-ext__progress-head">
              <span>Application progress</span>
              <strong>84%</strong>
            </div>
            <div className="xa-ext__progress"><i /></div>
            <ul className="xa-ext__panel-list">
              {PANEL_ROWS.map((row) => (
                <li key={row}><Check />{row}</li>
              ))}
            </ul>
            <p className="xa-ext__panel-foot">Review application →</p>
          </aside>
        </div>
      </div>
      <figcaption className="xa-ext__caption">
        Replace this illustration with an 8–12 second recording of the real extension filling an application.
      </figcaption>
    </figure>
  );
}
