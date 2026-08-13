"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";

/**
 * Pricing, as an overlay on the marketing page.
 *
 * PRESENTATION ONLY. There is no billing, subscription, plan or quota logic
 * anywhere in this repository — the API has no notion of a paid tier — so
 * nothing here reads or writes commercial state, and every plan's action is the
 * same signup route the rest of the page uses. When real billing arrives, the
 * plans below become its client, not its source of truth.
 *
 * Kept as an overlay rather than a route because the navbar entry is a detail
 * request in the middle of reading the page: sending the visitor to /pricing
 * would cost them their scroll position in the story for three short cards.
 * The standalone /pricing route is untouched and still resolves.
 */

type PricingApi = { open: () => void };

const PricingContext = createContext<PricingApi | null>(null);

/**
 * Opens the dialog. Returns null outside the provider so a component using it
 * stays renderable on its own (in a test, or in isolation).
 */
export function usePricingDialog(): PricingApi | null {
  return useContext(PricingContext);
}

const PLANS = [
  {
    name: "Free",
    price: "$0",
    cadence: "/ month",
    tag: null,
    description: "A real way to try the full XpertApply workflow before paying.",
    action: "Start free",
    features: [
      "Up to 30 job applications per month",
      "Job discovery and fit insights",
      "Application tracking",
      "Reusable career profile",
      "Browser extension autofill"
    ]
  },
  {
    name: "Pro",
    price: "$4.99",
    cadence: "/ month",
    tag: "MOST POPULAR",
    description: "For active job seekers who want to apply broadly without sacrificing quality.",
    action: "Choose Pro →",
    features: [
      "Unlimited job applications",
      "Everything in Free",
      "Tailored resume for each role",
      "Tailored cover letters",
      "Unlimited application tracking",
      "Priority preparation workflow"
    ]
  },
  {
    name: "Pro + Outreach",
    price: "$9.99",
    cadence: "/ month",
    tag: null,
    description: "For candidates who want applications and networking working together.",
    action: "Choose Pro + Outreach →",
    features: [
      "Everything in Pro",
      "Unlimited job applications",
      "Find relevant recruiters and employees",
      "Personalized recruiter/referral messages",
      "Send outreach through supported LinkedIn or email flows",
      "Track outreach alongside applications"
    ]
  }
];

export function PricingProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  /** The control that opened the dialog, so focus can go back where it started. */
  const opener = useRef<HTMLElement | null>(null);

  const api = useMemo<PricingApi>(
    () => ({
      open: () => {
        opener.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    }),
    []
  );

  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus?.();
  }, []);

  return (
    <PricingContext.Provider value={api}>
      {children}
      {open && <PricingModal onClose={close} />}
    </PricingContext.Provider>
  );
}

function PricingModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement | null>(null);

  // Escape closes, and Tab is kept inside the dialog. Both live on the document
  // rather than the dialog node so a keystroke still lands while focus is
  // momentarily on <body> (which is where it sits for one frame after mount).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;

      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The page behind must not scroll under the overlay. The scrollbar's width is
  // replaced with padding so the layout does not jump sideways as it is removed.
  useEffect(() => {
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, []);

  // Focus moves into the dialog on open so the next Tab is inside it.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  return (
    <div
      // `xa-theme` because this overlay is a SIBLING of the page element, not a
      // descendant: without it every brand token below resolves to nothing.
      className="xa-theme xa-pricing__backdrop"
      // The backdrop closes on click, but only when the click actually landed on
      // the backdrop — a drag that starts inside the dialog and releases outside
      // it must not dismiss the visitor's own work.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="xa-pricing-title"
        className="xa-pricing__dialog"
      >
        <button type="button" className="xa-pricing__close" onClick={onClose} aria-label="Close pricing">
          <X aria-hidden />
        </button>

        <div className="xa-pricing__head">
          <span className="xa-eyebrow">Simple pricing</span>
          <h2 id="xa-pricing-title">Pick the level of help you need.</h2>
          <p>
            Start free, then upgrade when you want unlimited applications, tailored materials,
            and direct outreach tools.
          </p>
        </div>

        <ul className="xa-pricing__plans">
          {PLANS.map((plan) => (
            <li
              key={plan.name}
              className="xa-pricing__plan"
              data-featured={plan.tag ? "true" : "false"}
            >
              <p className="xa-pricing__plan-name">
                {plan.name}
                {plan.tag && <span className="xa-pricing__tag">{plan.tag}</span>}
              </p>
              <p className="xa-pricing__price">
                <strong>{plan.price}</strong>
                {plan.cadence && <span>{plan.cadence}</span>}
              </p>
              <p className="xa-pricing__description">{plan.description}</p>
              <ul className="xa-pricing__features">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check aria-hidden />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`xa-btn ${plan.tag ? "xa-btn--primary" : "xa-btn--ghost"}`}
                onClick={onClose}
              >
                {plan.action}
                <span className="sr-only"> with the {plan.name} plan</span>
              </Link>
            </li>
          ))}
        </ul>

        <p className="xa-pricing__note">
          Cancel anytime. No long-term commitment. Outreach availability depends on supported
          integrations and user authorization.
        </p>
      </div>
    </div>
  );
}

/**
 * A control that opens the dialog, styled by its caller.
 *
 * A real <button>, never a div with a click handler: it opens an overlay rather
 * than navigating, so a link would lie about what it does.
 */
export function PricingTrigger({
  className,
  children
}: {
  className: string;
  children: React.ReactNode;
}) {
  const pricing = usePricingDialog();
  return (
    <button type="button" className={className} onClick={() => pricing?.open()}>
      {children}
    </button>
  );
}
