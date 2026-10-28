import Image from "next/image";
import { Check } from "lucide-react";
import { PRODUCT_SIDEBAR, type WorkflowStage } from "@/components/marketing/workflowStages";

/**
 * The sticky visual beside the workflow story.
 *
 * ONE component renders all six states, and it never draws a user interface.
 * Where a real product screenshot exists for a stage (sample data, no scores or
 * counts), it is shown matted like a print: a quiet frame, a hairline border and
 * a caption saying what it is. Every other stage shows the workflow index, which
 * is typography and a list of the six steps, not a picture of a screen that does
 * not exist. A frame of fixed proportion keeps the column from jumping while the
 * visitor scrolls between the two kinds.
 */
export function ProductDemo({ stage }: { stage: WorkflowStage }) {
  const { demo, shot } = stage;
  return (
    <div className="xa-vis" key={stage.id}>
      {shot ? (
        <figure className="xa-vis__shot">
          <div className="xa-vis__mat">
            <Image
              src={shot.src}
              width={shot.width}
              height={shot.height}
              alt={shot.alt}
              // Already a small WebP at its native size; the optimizer would resample it softer.
              unoptimized
            />
          </div>
          <figcaption>
            <b>{stage.label}</b> Product screenshot with sample data.
          </figcaption>
        </figure>
      ) : (
        <div className="xa-vis__index">
          <p className="xa-vis__numeral" aria-hidden>
            {stage.number}
          </p>
          <p className="xa-vis__label">{stage.label}</p>
          <ul className="xa-vis__points">
            {demo.panel.points.map((point) => (
              <li key={point}>
                <Check aria-hidden />
                {point}
              </li>
            ))}
          </ul>
          <ol className="xa-vis__steps" aria-hidden>
            {PRODUCT_SIDEBAR.map((item) => (
              <li key={item} data-current={item === demo.sidebarLabel}>
                {item}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
