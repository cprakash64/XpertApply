import Link from "next/link";

/**
 * The closing call to action.
 *
 * One heading, one sentence, one button. The page has already shown the product;
 * a second illustration here would only delay the click.
 */
export function FinalCta() {
  return (
    <section className="xa-final" aria-labelledby="xa-final-title">
      <div className="xa-shell">
        <div className="xa-final__card">
          <div className="xa-final__copy">
            <span className="xa-eyebrow">Get started</span>
            <h2 id="xa-final-title">
              Your next opportunity shouldn&rsquo;t get lost in{" "}
              <span className="xa-final__last-line">busywork.</span>
            </h2>
            <p>
              Bring discovery, preparation, networking, applications, and follow-up into one
              focused workflow.
            </p>
          </div>
          <div className="xa-final__action">
            <Link href="/signup" className="xa-btn xa-btn--primary">
              Get started free →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
