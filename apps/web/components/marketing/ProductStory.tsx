"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ProductDemo } from "@/components/marketing/ProductDemo";
import { WORKFLOW_STAGES } from "@/components/marketing/workflowStages";

/**
 * "XpertApply in Action" — the scroll-driven story.
 *
 * ─── How it works ─────────────────────────────────────────────────────────────
 *
 * There is ONE piece of state, `active`, and one continuous measurement,
 * `progress`. Everything visible derives from those two:
 *
 *   active    — which stage is at the viewport's midline. Decided by an
 *               IntersectionObserver whose root margin collapses the viewport to
 *               that single line, so exactly one stage can own it at a time.
 *               Drives the narrative emphasis, the product state, the sidebar
 *               selection and the bottom controller.
 *
 *   progress  — 0→1 across the whole story, measured from the first stage's
 *               centre to the last stage's centre. Drives the rail's height and
 *               its colour, and is written to CSS custom properties rather than
 *               to React state: it changes on every frame of a scroll, and
 *               re-rendering six stages and a product mock that often would be
 *               the one thing on this page that could stutter.
 *
 * Neither listener does layout work inline. Scroll and resize only request an
 * animation frame; all reading and writing happens inside that frame, so the
 * browser never interleaves a measure with a style write.
 *
 * ─── Why the rail is one element and not two ─────────────────────────────────
 *
 * A cyan bar with a navy bar drawn over it reads as two competing tracks. Here
 * the completed portion is a single gradient from cyan at the origin to
 * `--rail-progress-color` at its own moving end — and that end colour is
 * interpolated from cyan toward navy by the same `progress` that sets the
 * height. So the line does not gain a second colour; it matures into one. The
 * active marker takes the identical colour, which is what makes the marker and
 * the rail's leading edge read as the same moment in the journey.
 */

/** #14B8C4 → #06245C, the cyan-to-navy journey, as RGB triples. */
const RAIL_FROM = [20, 184, 196] as const;
const RAIL_TO = [6, 36, 92] as const;

function railColor(progress: number): { solid: string; glow: string } {
  const channel = (i: number) =>
    Math.round(RAIL_FROM[i] + (RAIL_TO[i] - RAIL_FROM[i]) * progress);
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  return { solid: `rgb(${r} ${g} ${b})`, glow: `rgb(${r} ${g} ${b} / 14%)` };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function ProductStory() {
  const [active, setActive] = useState(0);
  const section = useRef<HTMLElement | null>(null);
  const narrative = useRef<HTMLDivElement | null>(null);
  const stages = useRef<(HTMLElement | null)[]>([]);
  const frame = useRef<number | null>(null);

  /*
   * Measure and paint, inside one animation frame.
   *
   * The neutral track spans from the narrative's start to the story section's
   * lower boundary, with a small optical inset before the next section. Its
   * fill is normalized across the section's full scrollable
   * distance, so it starts empty, passes every marker, and continues below the
   * last stage until the following section is reached. Stage activation remains
   * independently anchored to the viewport midpoint.
   */
  const measure = useCallback(() => {
    frame.current = null;
    const column = narrative.current;
    const root = section.current;
    const nodes = stages.current.filter(Boolean) as HTMLElement[];
    if (!column || !root || nodes.length < 2) return;

    const first = nodes[0];
    const rootRect = root.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const railTop = first.offsetTop;
    const railEndInset = Math.min(96, Math.max(64, window.innerHeight * 0.09));
    const railBottom = rootRect.bottom - columnRect.top - railEndInset;
    const railSpan = railBottom - railTop;
    const scrollSpan = root.offsetHeight - window.innerHeight;
    if (railSpan <= 0 || scrollSpan <= 0) return;

    const progress = clamp01(-rootRect.top / scrollSpan);
    const fillHeight = progress * railSpan;
    const { solid, glow } = railColor(progress);

    root.style.setProperty("--xa-rail-top", `${railTop}px`);
    root.style.setProperty("--xa-rail-height", `${railSpan}px`);
    root.style.setProperty("--xa-rail-fill-height", `${fillHeight}px`);
    root.style.setProperty("--xa-progress", String(progress));
    root.style.setProperty("--rail-progress-color", solid);
    root.style.setProperty("--rail-glow-color", glow);
  }, []);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    // Stage heights depend on wrapped text, which changes with the viewport and
    // with font loading — neither of which fires a resize on the window.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (observer && narrative.current) observer.observe(narrative.current);

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, [schedule]);

  /*
   * Stage activation.
   *
   * `-50% 0px -50% 0px` shrinks the observer's root to a zero-height line at the
   * viewport's midline — the same anchor the rail measures against, so the two
   * can never disagree about where "now" is. When no stage crosses the line
   * (above the first, below the last) the previous stage simply stays active,
   * which is the behaviour you want at both ends of the story.
   */
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (Number.isInteger(index)) setActive(index);
        }
      },
      { rootMargin: "-50% 0px -50% 0px", threshold: 0 }
    );

    for (const node of stages.current) if (node) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /** The bottom controller scrolls the narrative to the stage it names. */
  const goToStage = useCallback((index: number) => {
    const node = stages.current[index];
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const top = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
  }, []);

  const stage = WORKFLOW_STAGES[active];

  return (
    <section
      id="story"
      ref={section}
      className="xa-story"
      // Until this is "true" the stylesheet keeps every stage at full opacity,
      // so the section is readable before hydration and with JavaScript off.
      data-ready="true"
      aria-labelledby="xa-story-title"
    >
      <div className="xa-shell">
        <div className="xa-story__intro xa-section-head">
          <span className="xa-eyebrow">XpertApply in action</span>
          <h2
            id="xa-story-title"
            aria-label="From discovery to follow-up, it all stays connected."
          >
            From discovery to <span className="xa-story__keep">follow-up</span>, it all stays
            connected.
          </h2>
          <p>
            See how XpertApply brings the entire job search into one clear workflow — helping you
            focus your time where it matters most.
          </p>
        </div>

        <div className="xa-story__grid">
          <div className="xa-narrative" ref={narrative}>
            <div className="xa-rail" aria-hidden>
              <span className="xa-rail__track" />
              <span className="xa-rail__fill" />
            </div>

            {WORKFLOW_STAGES.map((item, index) => (
              <article
                key={item.id}
                // A real anchor per stage, so the footer's capability links have
                // somewhere honest to point instead of a fabricated route.
                id={`stage-${item.id}`}
                data-index={index}
                data-state={
                  index === active ? "active" : index < active ? "done" : "upcoming"
                }
                className="xa-stage"
                ref={(node) => {
                  stages.current[index] = node;
                }}
              >
                <span aria-hidden className="xa-stage__marker" />
                <p className="xa-stage__index">
                  <em>{item.number}</em>
                  {item.label}
                </p>
                <h3>{item.headline}</h3>
                <p className="xa-stage__body">{item.body}</p>
                <ul className="xa-stage__benefits">
                  {item.benefits.map((benefit) => (
                    <li key={benefit}>
                      <Check aria-hidden />
                      {benefit}
                    </li>
                  ))}
                </ul>

                {/*
                  * Below the desktop breakpoint the story is a plain sequence:
                  * each stage is immediately followed by the product state it
                  * describes, instead of pointing at a sticky column that is not
                  * there. Hidden on desktop by CSS, where the sticky mock takes
                  * over.
                  */}
                <div className="xa-stage__inline-demo">
                  <ProductDemo stage={item} />
                </div>
              </article>
            ))}
          </div>

          <div className="xa-story__sticky">
            <ProductDemo stage={stage} />

            {/*
              * Plain buttons rather than ARIA tabs: nothing here is a tabpanel,
              * and the controller's job is to scroll the narrative, not to swap
              * a region. `aria-current` says which stage the page is on; the
              * accessible name says what pressing it does.
              */}
            <div className="xa-controller" role="group" aria-label="Jump to a workflow stage">
              {WORKFLOW_STAGES.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={index === active ? "true" : undefined}
                  className="xa-controller__item"
                  onClick={() => goToStage(index)}
                >
                  {item.controllerLabel}
                </button>
              ))}
            </div>

          </div>
        </div>
      </div>
    </section>
  );
}
