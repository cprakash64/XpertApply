import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/siteConfig";
import { BrandWordmark } from "@/components/marketing/BrandWordmark";

/**
 * The footer.
 *
 * Every linked entry resolves. Reference labels without a production route stay
 * visible as quiet text so the approved Product / Company / Resources / Legal
 * taxonomy and column geometry are preserved without introducing dead links.
 *
 * Terms is the one deliberate omission from the approved footer: there is no
 * /terms route yet. It belongs here the day the page ships, and not before.
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
                <li>
                  <span className="xa-footer__static">About</span>
                </li>
                <li>
                  <span className="xa-footer__static">Careers</span>
                </li>
                <li><span className="xa-footer__static">Contact</span></li>
              </ul>
            </div>

            <div>
              <h3>Resources</h3>
              <ul>
                <li>
                  <a href="#story" className="xa-footer__link">Product tour</a>
                </li>
                <li><span className="xa-footer__static">Help center</span></li>
                <li><span className="xa-footer__static">Blog</span></li>
              </ul>
            </div>

            <div>
              <h3>Legal</h3>
              <ul>
                <li>
                  <a href="#security" className="xa-footer__link">
                    Security
                  </a>
                </li>
                <li>
                  <Link href="/privacy" className="xa-footer__link">
                    Privacy
                  </Link>
                </li>
                <li><span className="xa-footer__static">Terms</span></li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="xa-footer__bottom">
          <p>
            &copy; 2026 {PRODUCT_NAME}
          </p>
          <p>Apply smarter. Get hired.</p>
        </div>
      </div>
    </footer>
  );
}
