/**
 * Why can't JobPilot reach the embedded application?
 *
 * The live failure: the destination application renders inside an iframe and
 * the widget said "The application is inside a frame JobPilot isn't allowed to
 * read." That verdict came from one fact — `contentDocument` threw — which only
 * ever proves the frame is cross-origin. It gave the user no action and us no
 * diagnosis, and it was reached without ever checking whether a content script
 * was running there or whether a host permission existed.
 *
 * These tests pin the distinctions that message was hiding.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyFrameUrl,
  frameVerdict,
  observeFrames,
  redactPathShape,
  reopenableFrameUrl,
  selectApplicationFrame,
  type ObservedFrame
} from "../frames/frameInventory";

function frame(overrides: Partial<ObservedFrame> = {}): ObservedFrame {
  return {
    frameIndex: 0,
    origin: "https://ats.example.test",
    pathShape: "/apply",
    urlKind: "https",
    srcObservable: true,
    sandboxTokens: [],
    sandboxed: false,
    opaqueOrigin: false,
    sameOriginReadable: false,
    readableFieldCount: 0,
    ...overrides
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("frame url classification", () => {
  it.each([
    ["https://ats.example.test/apply", "https"],
    ["http://localhost:4000/apply", "http_local"],
    ["about:blank", "about_blank"],
    ["about:srcdoc", "about_srcdoc"],
    ["blob:https://ats.example.test/abc", "blob"],
    ["data:text/html,<form>", "data"],
    ["", "empty"],
    [null, "empty"]
  ])("classifies %s", (raw, expected) => {
    expect(classifyFrameUrl(raw as string | null)).toBe(expected);
  });

  it("redacts identifiers out of a frame path", () => {
    expect(redactPathShape("https://ats.example.test/en-US/apply/7412998877665544/form?token=secret"))
      .toBe("/<locale>/apply/<id>/form");
  });
});

describe("observing this document's frames", () => {
  it("reads src and sandbox tokens the parent owns, across origins", () => {
    // `src` and `sandbox` are the PARENT's markup, so they stay readable even
    // when the frame's document does not. That is what makes a remedy possible.
    document.body.innerHTML = `
      <iframe src="https://ats.example.test/apply/993312440011" sandbox="allow-scripts allow-forms"></iframe>`;
    const [observed] = observeFrames(document);

    expect(observed).toMatchObject({
      origin: "https://ats.example.test",
      pathShape: "/apply/<id>",
      urlKind: "https",
      srcObservable: true,
      sandboxed: true,
      // allow-scripts without allow-same-origin: opaque, unreachable by grant.
      opaqueOrigin: true
    });
    expect(observed.sandboxTokens).toEqual(["allow-scripts", "allow-forms"]);
  });

  it("treats a sandbox WITH allow-same-origin as reachable", () => {
    document.body.innerHTML = `<iframe src="https://ats.example.test/apply" sandbox="allow-scripts allow-same-origin"></iframe>`;
    expect(observeFrames(document)[0].opaqueOrigin).toBe(false);
  });

  it("records a script-populated frame that has no URL at all", () => {
    // Nothing to open and nothing to grant. Saying "reopen it" here would
    // produce a broken tab, so the remedy must be withheld.
    document.body.innerHTML = `<iframe></iframe>`;
    const [observed] = observeFrames(document);
    expect(observed.urlKind).toBe("empty");
    expect(observed.origin).toBeNull();
    expect(reopenableFrameUrl(observed, document)).toBeNull();
  });

  it("counts fields in a frame it can actually read", () => {
    document.body.innerHTML = `<iframe id="same"></iframe>`;
    const element = document.querySelector<HTMLIFrameElement>("#same")!;
    element.contentDocument!.body.innerHTML = `
      <form><input name="first_name"><input name="last_name"><input name="email"></form>`;
    const [observed] = observeFrames(document);
    expect(observed.sameOriginReadable).toBe(true);
    expect(observed.readableFieldCount).toBe(3);
  });
});

describe("choosing the frame and naming the cause", () => {
  it("prefers a readable frame that actually has controls", () => {
    const chosen = selectApplicationFrame([
      frame({ frameIndex: 0, urlKind: "empty", origin: null }),
      frame({ frameIndex: 1, readableFieldCount: 8, sameOriginReadable: true })
    ]);
    expect(chosen?.frameIndex).toBe(1);
  });

  it.each([
    [
      "an opaque sandbox, which no permission grant can ever reach",
      { frame: frame({ opaqueOrigin: true, sandboxed: true }), contentScriptResponds: false, hostPermissionGranted: false, reportedFieldCount: null },
      "APPLICATION_FRAME_SANDBOXED_OPAQUE"
    ],
    [
      "a normal origin we simply have no permission for",
      { frame: frame(), contentScriptResponds: false, hostPermissionGranted: false, reportedFieldCount: null },
      "APPLICATION_FRAME_PERMISSION_MISSING"
    ],
    [
      "a permitted origin whose content script never answered",
      { frame: frame(), contentScriptResponds: false, hostPermissionGranted: true, reportedFieldCount: null },
      "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE"
    ],
    [
      "a reachable frame that found nothing",
      { frame: frame(), contentScriptResponds: true, hostPermissionGranted: true, reportedFieldCount: 0 },
      "APPLICATION_FRAME_DISCOVERY_ZERO_FIELDS"
    ],
    [
      "a reachable frame that found the application",
      { frame: frame(), contentScriptResponds: true, hostPermissionGranted: true, reportedFieldCount: 11 },
      "APPLICATION_FRAME_DISCOVERY_COMPLETED"
    ]
  ])("names %s", (_label, input, expected) => {
    expect(frameVerdict(input)).toBe(expected);
  });

  it("never collapses four different causes into one message", () => {
    const causes = new Set([
      frameVerdict({ frame: frame({ opaqueOrigin: true }), contentScriptResponds: false, hostPermissionGranted: false, reportedFieldCount: null }),
      frameVerdict({ frame: frame(), contentScriptResponds: false, hostPermissionGranted: false, reportedFieldCount: null }),
      frameVerdict({ frame: frame(), contentScriptResponds: false, hostPermissionGranted: true, reportedFieldCount: null }),
      frameVerdict({ frame: frame(), contentScriptResponds: true, hostPermissionGranted: true, reportedFieldCount: 0 })
    ]);
    expect(causes.size).toBe(4);
  });
});

describe("reopening the frame as its own tab", () => {
  it("returns the frame's https url so the existing destination path can open it", () => {
    document.body.innerHTML = `<iframe src="https://ats.example.test/apply/998811"></iframe>`;
    const observed = observeFrames(document);
    expect(reopenableFrameUrl(observed[0], document)).toBe("https://ats.example.test/apply/998811");
  });

  it.each([
    ["about:blank", `<iframe src="about:blank"></iframe>`],
    ["a blob url", `<iframe src="blob:https://ats.example.test/abc"></iframe>`],
    ["a data url", `<iframe src="data:text/html,<form></form>"></iframe>`],
    ["no src at all", `<iframe></iframe>`]
  ])("refuses to reopen %s", (_label, markup) => {
    document.body.innerHTML = markup;
    expect(reopenableFrameUrl(observeFrames(document)[0], document)).toBeNull();
  });
});
