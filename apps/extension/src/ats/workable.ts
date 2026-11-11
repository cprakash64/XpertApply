import type { ATSAdapter, DetectionResult, PageContext } from "../types";
import { baseDiscover, baseMap, findGenericSubmit, hostMatches } from "./base";

/**
 * Workable (apply.workable.com/<company>/j/<CODE>/apply/). Markup verified on public postings, read-only: one
 * `form[data-ui="application-form"]` rendered client-side, `data-ui` hooks on its controls (firstname, lastname, email, resume,
 * apply-button), a visually hidden `input[type=file]` behind a "Choose file" label, labels carried by `aria-labelledby` spans with a
 * leading "*". Field discovery and mapping are the shared engine's; this adapter names the ATS and finds the (never clicked) submit.
 * Support stays "limited" until a real, authorised application has been filled on the live site.
 */
export const WorkableAdapter: ATSAdapter = {
  id: "workable",
  displayName: "Workable",
  detect(context: PageContext): DetectionResult {
    const { url, document: doc } = context;
    let confidence = 0;
    if (hostMatches(url, "apply.workable.com")) confidence += 0.6;
    if (doc.querySelector('form[data-ui="application-form"]')) confidence += 0.3;
    if (doc.querySelector('[data-ui="firstname"], [data-ui="resume"], [data-ui="apply-button"]')) confidence += 0.1;
    return { atsId: this.id, matched: confidence >= 0.6, confidence: Math.min(confidence, 1) };
  },
  discoverFields: (context) => baseDiscover(context),
  mapFields: (fields, session) => baseMap(fields, session),
  findSubmitControl: (context) =>
    context.document.querySelector<HTMLElement>('[data-ui="apply-button"]') ?? findGenericSubmit(context)
};
