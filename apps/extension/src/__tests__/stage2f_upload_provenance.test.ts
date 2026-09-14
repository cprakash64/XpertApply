/**
 * An upload is verified against the EMPLOYER'S control, never against the fact
 * that a document was fetched.
 *
 * The Stage 2F correction: the last-resort branch used to accept "the file is
 * on the input" without asking whether that input was still in the document. A
 * framework that replaces the file input after an upload leaves the old node
 * detached with its `FileList` intact, so reading it back proves nothing about
 * what the employer's form now holds — and `upload_verified` is the one claim
 * the user cannot check for themselves from the ledger.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutofill } from "../content/autofill";
import { detectAdapter } from "../ats/registry";
import type { ApplicationSessionData } from "../types";

function session(): ApplicationSessionData {
  return {
    sessionId: 9, atsType: null,
    officialUrl: "https://boards.greenhouse.io/acme/jobs/1",
    jobTitle: "Engineer", jobLocation: "San Francisco, CA", company: "Acme",
    unresolvedQuestions: [],
    answers: [{
      canonical_key: "first_name", value: "Ada", display_value: "Ada", source: "profile",
      confidence: 1, sensitive: false, requires_review: false, verified: true
    }]
  };
}

function mount(): void {
  document.body.innerHTML = `
    <form id="application">
      <label for="firstName">First name</label><input id="firstName" name="first_name" />
      <div id="resume-wrap"><label for="resume">Resume</label><input id="resume" name="resume" type="file" /></div>
      <button type="submit">Submit application</button>
    </form>`;
}

function outcome() {
  return detectAdapter({ url: "https://boards.greenhouse.io/acme/jobs/1", document })!;
}

const resume = () => new File(["%PDF-1.4"], "ada-resume.pdf", { type: "application/pdf" });

/**
 * JSDOM ships no `DataTransfer`, and no settable `files`. The browser has both,
 * and the upload path is built on them — without these the code under test
 * fails before it reaches the behaviour being asserted. This supplies the
 * minimum the real implementation touches and nothing more.
 */
function installFileApis(): void {
  class FakeDataTransfer {
    private readonly list: File[] = [];
    readonly items = {
      add: (file: File) => { this.list.push(file); }
    };
    get files(): FileList {
      const list = this.list;
      return Object.assign(list.slice(), {
        item: (index: number) => list[index] ?? null,
        length: list.length
      }) as unknown as FileList;
    }
  }
  vi.stubGlobal("DataTransfer", FakeDataTransfer);
  Object.defineProperty(HTMLInputElement.prototype, "files", {
    configurable: true,
    get(this: HTMLInputElement & { __files?: FileList }) {
      return this.__files ?? ({ length: 0, item: () => null } as unknown as FileList);
    },
    set(this: HTMLInputElement & { __files?: FileList }, value: FileList) {
      this.__files = value;
    }
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  installFileApis();
});

describe("upload provenance", () => {
  it("reports the upload when the connected control holds the exact file", async () => {
    mount();
    const result = await runAutofill(session(), outcome(), {
      fetchDocument: async (kind) => (kind === "resume" ? resume() : null)
    });
    expect(result.result.documents_uploaded).toContain("resume");
    const input = document.getElementById("resume") as HTMLInputElement;
    expect(input.files?.[0]?.name).toBe("ada-resume.pdf");
  }, 20_000);

  it("does NOT report the upload when the framework replaces the input afterwards", async () => {
    mount();
    const original = document.getElementById("resume") as HTMLInputElement;
    // A controlled component re-renders and swaps in a fresh input. The old
    // node keeps its FileList; the employer's form holds nothing.
    original.addEventListener("change", () => {
      const wrap = document.getElementById("resume-wrap")!;
      const replacement = original.cloneNode(false) as HTMLInputElement;
      original.remove();
      wrap.appendChild(replacement);
    });

    const result = await runAutofill(session(), outcome(), {
      fetchDocument: async (kind) => (kind === "resume" ? resume() : null)
    });

    // The decisive assertion: no false success.
    expect(result.result.documents_uploaded).not.toContain("resume");
    // Surfaced for the user instead, never counted as uploaded.
    expect(result.result.review_items).toBeGreaterThan(0);
    // The detached node still holds the file — which is exactly why reading it
    // back was never proof.
    expect(original.isConnected).toBe(false);
    expect(original.files?.[0]?.name).toBe("ada-resume.pdf");
    // And the live control the employer would submit is empty.
    expect((document.getElementById("resume") as HTMLInputElement).files?.length ?? 0).toBe(0);
  }, 20_000);

  it("never claims an upload when no document could be fetched", async () => {
    mount();
    const result = await runAutofill(session(), outcome(), { fetchDocument: async () => null });
    expect(result.result.documents_uploaded).not.toContain("resume");
    // Surfaced for the user instead, never counted as uploaded.
    expect(result.result.review_items).toBeGreaterThan(0);
  }, 20_000);
});
