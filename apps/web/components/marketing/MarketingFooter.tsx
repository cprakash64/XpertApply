import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/siteConfig";
import { BrandWordmark } from "@/components/marketing/BrandWordmark";

/**
 * The footer.
 *
 * Every entry is a working link. Labels for pages that do not exist (About,
 * Careers, Help center, Blog, Terms) were removed rather than shown as inert
 * text: a footer that lists pages a visitor cannot open reads as unfinished.
 * Each one belongs here the day its page ships, and not before.
 */
const PRODUCT_LINKS = [
  { href: "#stage-discover", label: "Job discovery" },
  { href: "#stage-apply", label: "Applications" },
  { href: "#extension", label: "Extension" }
];

export function MarketingFooter() {
  return (
    <footer className="xa-footer">
      <div className="xa-shell">
        <div className="xa-footer__top">
          <div>
            <BrandWordmark />
            <p className="xa-footer__blurb">
              One workspace to discover better opportunities, prepare stronger applications,
              connect with the right people, and stay organized.
            </p>
          </div>

          <nav aria-label="Footer" className="xa-footer__groups">
            <div>
              <h3>Product</h3>
              <ul>
                {PRODUCT_LINKS.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className="xa-footer__link">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3>Company</h3>
              <ul>
                <li><Link href="/pricing" className="xa-footer__link">Pricing</Link></li>
                <li><Link href="/opensource" className="xa-footer__link">Open source</Link></li>
                <li><a href="mailto:privacy@xpertapply.com" className="xa-footer__link">Privacy contact</a></li>
              </ul>
            </div>

            <div>
              <h3>Resources</h3>
              <ul>
                <li><a href="#story" className="xa-footer__link">Product tour</a></li>
                <li><a href="#security" className="xa-footer__link">Security</a></li>
              </ul>
            </div>

            <div>
              <h3>Legal</h3>
              <ul>
                <li><Link href="/privacy" className="xa-footer__link">Privacy</Link></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="xa-footer__bottom">
          <p>
            &copy; 2026 {PRODUCT_NAME}
          </p>
        </div>
      </div>
    </footer>
  );
}
