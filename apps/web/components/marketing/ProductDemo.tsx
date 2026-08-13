import { Check } from "lucide-react";
import { BrandWordmark } from "@/components/marketing/BrandWordmark";
import { PRODUCT_SIDEBAR, type WorkflowStage } from "@/components/marketing/workflowStages";

/**
 * The product demonstration inside a restrained browser window.
 *
 * ONE component renders all six states. The stage data decides the sidebar
 * selection, the workspace title, the rows and the detail panel, which is what
 * keeps six near-identical screens from becoming six near-identical blocks of
 * markup that drift apart the first time a label changes.
 *
 * The shell — chrome, sidebar, borders — is stable across stages; only the panes
 * inside it animate, so the window never appears to jump while the content
 * changes underneath it. The `key` on the panes is what restarts that animation
 * on each stage change.
 *
 * Everything here is illustrative. The buttons are spans: they are pictures of
 * controls, and a real <button> that does nothing is worse than a picture of
 * one, both for a keyboard user and for anyone who tries it.
 */
const JOBS = [
  { initial: "S", title: "Senior Software Engineer", meta: "Stripe · New York, NY · 2h ago", score: "92" },
  { initial: "A", title: "Software Engineer, Product", meta: "Airbnb · Remote · 5h ago", score: "87" },
  { initial: "N", title: "Backend Engineer", meta: "Notion · San Francisco · 1d ago", score: "83" },
  { initial: "C", title: "Full Stack Engineer", meta: "Canva · Remote · 1d ago", score: "79" }
] as const;

export function ProductDemo({ stage }: { stage: WorkflowStage }) {
  const { demo } = stage;
  // The meter reads the panel metric where that metric is a score out of 100,
  // and falls back to a full bar for counts (people found, applications open),
  // which have no denominator to draw against.
  const numeric = Number(demo.panel.metric);
  const meter = Number.isFinite(numeric) && numeric <= 100 ? numeric : 100;

  return (
    <div className="xa-mock">
      <div className="xa-mock__chrome" aria-hidden>
        <span className="xa-mock__dots">
          <span />
          <span />
          <span />
        </span>
        <span className="xa-mock__url">app.xpertapply.com</span>
      </div>

      <div className="xa-mock__body">
        <div className="xa-mock__sidebar" aria-hidden>
          <span className="xa-mock__brand">
            <BrandWordmark />
          </span>
          {PRODUCT_SIDEBAR.map((item) => {
            return (
              <span
                key={item}
                className="xa-mock__nav-item"
                data-current={item === demo.sidebarLabel}
              >
                <i aria-hidden />
                {item}
              </span>
            );
          })}
        </div>

        <div className="xa-mock__panes" key={stage.id}>
          <div className="xa-mock__workspace">
            <div className="xa-mock__head">
              <div>
                <span>{demo.workspaceMeta}</span>
                <h4>{demo.workspaceTitle}</h4>
              </div>
              <i aria-hidden />
            </div>
            <ul className="xa-mock__rows">
              {JOBS.map((job, index) => (
                <li key={job.title} className="xa-mock__row" data-state={index === 0 ? "active" : "idle"}>
                  <span aria-hidden className="xa-mock__company">{job.initial}</span>
                  <span className="xa-mock__row-text">
                    <span className="xa-mock__row-title">{job.title}</span>
                    <span className="xa-mock__row-meta">{job.meta}</span>
                  </span>
                  <span className="xa-mock__score">
                    <strong>{job.score}</strong>
                    <small>FIT</small>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="xa-mock__panel">
            <h5>{demo.panel.title}</h5>
            <p className="xa-mock__metric">
              <strong>{demo.panel.metric}</strong>
              <span>{demo.panel.metricCaption}</span>
            </p>
            <div className="xa-mock__meter" aria-hidden>
              <i style={{ width: `${meter}%` }} />
            </div>
            <ul className="xa-mock__points">
              {demo.panel.points.map((point) => (
                <li key={point}>
                  <Check aria-hidden />
                  {point}
                </li>
              ))}
            </ul>
            <div className="xa-mock__actions" aria-hidden>
              <span className="xa-mock__action xa-mock__action--primary">
                {demo.panel.actions[0]}
              </span>
              <span className="xa-mock__action xa-mock__action--secondary">
                {demo.panel.actions[1]}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
