import type { ATSAdapter, DetectionResult, PageContext } from "../types";
import { baseDiscover, baseMap, hostMatches } from "./base";

import { classifyWorkdayStep, findWorkdayFinalSubmit, findWorkdaySafeNext } from "./workdayStep";

export function isWorkdayReviewPage(context: PageContext): boolean {
  return classifyWorkdayStep(context.document) === "review";
}

/** Safe forward control only: never Submit, Sign in, Create account or the start-choice buttons. */
export function findWorkdayNextControl(context: PageContext): HTMLElement | null {
  return findWorkdaySafeNext(context.document);
}

function findFinalSubmit(context: PageContext): HTMLElement | null {
  return findWorkdayFinalSubmit(context.document);
}

export const WorkdayAdapter: ATSAdapter = {
  id: "workday",
  displayName: "Workday",
  detect(context: PageContext): DetectionResult {
    let confidence = 0;
    if (hostMatches(context.url, "myworkdayjobs.com") || hostMatches(context.url, "myworkdaysite.com") || hostMatches(context.url, "workday.com")) confidence += 0.75;
    if (context.document.querySelector('[data-automation-id], script[src*="workday" i], link[href*="workday" i]')) confidence += 0.2;
    return { atsId: this.id, matched: confidence >= 0.7, confidence: Math.min(confidence, 1) };
  },
  discoverFields: (context) => baseDiscover(context),
  mapFields: (fields, session) => baseMap(fields, session),
  findSubmitControl: findFinalSubmit,
  findNextControl: findWorkdayNextControl,
  isReviewPage: isWorkdayReviewPage
};
