import Link from "next/link";
import { Check } from "lucide-react";

/**
 * The hero.
 *
 * Deliberately editorial: type, two calls to action, and three control
 * promises. There is no screenshot, no video and no illustration behind the
 * headline — the product demonstration is the next section's job, and putting a
 * preview here would make the reader work out what they are looking at before
 * they have read what it is.
 *
 * The background is a flat porcelain surface: no gradient, glow or monogram.
 */
const TRUST = ["No auto-submit", "You stay in control", "One profile across applications"];

export function Hero() {
  return (
    <section className="xa-hero">
      <div className="xa-shell">
        <div className="xa-hero__inner">
          <span className="xa-eyebrow xa-eyebrow--dot">Built for the whole job search</span>

          <h1>
            <span>Find the right job.</span>
            <span className="xa-hero__line-2">Apply with confidence.</span>
          </h1>

          <p className="xa-hero__lede">
            Discover roles worth your time, tailor every application, connect with the right
            people, and move through repetitive application fields faster — all in one workspace.
          </p>

          <div className="xa-cta-row">
            <Link href="/signup" className="xa-btn xa-btn--primary">
              Get started →
            </Link>
            <a href="#story" className="xa-btn xa-btn--ghost">
              See XpertApply in action ↓
            </a>
          </div>

          <ul className="xa-hero__trust">
            {TRUST.map((item) => (
              <li key={item}>
                <Check aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
