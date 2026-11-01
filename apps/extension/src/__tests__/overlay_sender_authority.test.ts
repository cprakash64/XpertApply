import { describe, expect, it } from "vitest";
import { authorizeOverlayDocument } from "../security/senderTrust";

const EXTENSION_ID = "xpertapply-extension";

function sender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: EXTENSION_ID,
    tab: { id: 17, url: "https://jobs.example/apply" } as chrome.tabs.Tab,
    frameId: 0,
    documentId: "document-a",
    url: "https://jobs.example/apply",
    ...overrides
  };
}

describe("in-page overlay sender authority", () => {
  it("accepts only the registered top-document identity", () => {
    expect(authorizeOverlayDocument(sender(), EXTENSION_ID, "document-a")).toMatchObject({
      ok: true, tabId: 17, documentId: "document-a"
    });
    expect(authorizeOverlayDocument(sender({ documentId: "document-b" }), EXTENSION_ID, "document-a"))
      .toEqual({ ok: false, reason: "OVERLAY_DOCUMENT_STALE" });
  });

  it("accepts a newly registered document after same-tab navigation", () => {
    const navigated = sender({ documentId: "document-b", url: "https://jobs.example/apply?step=2" });
    expect(authorizeOverlayDocument(navigated, EXTENSION_ID, "document-b")).toMatchObject({
      ok: true, tabId: 17, documentId: "document-b"
    });
  });

  it("does not make URL equality the document authority", () => {
    const sameDocumentNewUrl = sender({ url: "https://jobs.example/apply#review" });
    expect(authorizeOverlayDocument(sameDocumentNewUrl, EXTENSION_ID, "document-a")).toMatchObject({ ok: true });
  });

  it("rejects spoofed extension pages, absent tabs, and subframes", () => {
    expect(authorizeOverlayDocument(sender({ id: "other" }), EXTENSION_ID, "document-a"))
      .toEqual({ ok: false, reason: "UNTRUSTED_EXTENSION_SENDER" });
    expect(authorizeOverlayDocument(sender({ tab: undefined }), EXTENSION_ID, "document-a"))
      .toEqual({ ok: false, reason: "OVERLAY_SENDER_TAB_MISSING" });
    expect(authorizeOverlayDocument(sender({ frameId: 4 }), EXTENSION_ID, "document-a"))
      .toEqual({ ok: false, reason: "OVERLAY_SENDER_FRAME_INVALID" });
  });
});
