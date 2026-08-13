import { FileCheck2, ShieldCheck, UserRound } from "lucide-react";

/**
 * The trust section — the page's one solid navy break.
 *
 * A deliberate change of ground: after a long light page, a full-bleed navy band
 * marks this as the part that is not a feature list. The three cards are
 * behaviours the product actually has, not commitments invented for a marketing
 * page.
 */
const CARDS = [
  {
    icon: ShieldCheck,
    title: "Review before submission",
    body: "You decide what gets sent and when."
  },
  {
    icon: UserRound,
    title: "Reusable profile",
    body: "Keep your application information organized and reusable in one place."
  },
  {
    icon: FileCheck2,
    title: "Grounded application materials",
    body: "Tailoring stays grounded in your actual background and experience."
  }
];

export function TrustSection() {
  return (
    <section id="security" className="xa-trust" aria-labelledby="xa-trust-title">
      <div className="xa-shell">
        <div className="xa-trust__grid">
          <div className="xa-section-head">
            <span className="xa-eyebrow">Designed around trust</span>
            <h2 id="xa-trust-title">Automation without losing control.</h2>
            <p>
              Move faster without giving up control. XpertApply helps with repetitive work while
              keeping important decisions visible, reviewable, and yours.
            </p>
          </div>

          <ul className="xa-trust__cards">
            {CARDS.map((card) => (
              <li key={card.title} className="xa-trust__card">
                <span className="xa-trust__icon"><card.icon aria-hidden /></span>
                <div>
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
