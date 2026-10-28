import { findSections, findAddControl } from "../application/sectionControls";
import { discoverUploadInputs } from "../ats/base";
(window as unknown as Record<string, unknown>).__jpSections = () => {
  const sections = findSections(document).map((match) => {
    const add = findAddControl(match);
    return {
      section: match.section,
      reason: match.reason,
      heading: (match.heading.textContent ?? "").trim().slice(0, 40),
      containerTag: match.container.tagName,
      containerId: (match.container as HTMLElement).id || null,
      addFound: Boolean(add),
      addTag: add?.tagName ?? null,
      addName: add ? (add.getAttribute("aria-label") ?? (add.getRootNode() as ShadowRoot).host?.getAttribute("aria-label") ?? "") : null
    };
  });
  const uploads = discoverUploadInputs(document).map((t) => ({
    kind: t.kind,
    host: ((t.input.getRootNode() as ShadowRoot).host as HTMLElement)?.getAttribute("data-test") ?? null
  }));
  return { sections, uploads };
};
