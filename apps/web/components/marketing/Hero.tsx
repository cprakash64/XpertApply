import Link from "next/link";
import { Check } from "lucide-react";
import { HeroPreview } from "@/components/marketing/HeroPreview";

/**
 * The hero.
 *
 * An editorial split: the proposition and its two calls to action on the left,
 * a picture of the product on the right, so the first screen shows what
 * XpertApply does and not only what it says. The picture is illustrative and
 * labelled as such (see HeroPreview); it makes no claim a fact would have to
 * back. No gradient, glow or illustration sits behind either column.
 */
const TRUST = ["No auto-submit", "You stay in control", "One profile across applications"];

export function Hero() {
  return (
    <section className="xa-hero">
      <div className="xa-shell">
        <div className="xa-hero__grid">
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
          <HeroPreview />
        </div>
      </div>
    </section>
  );
}
