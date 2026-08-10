import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationEligibility } from "../components/ApplicationEligibility";

/** The three legal questions: unanswered must never look like "No". */

const FIELDS = ["work_authorization_us", "sponsorship_required_now", "sponsorship_required_future"];

function unanswered() {
  return {
    answers: FIELDS.map((field) => ({
      field,
      prompt: `Prompt for ${field}`,
      answer: null,
      answered: false,
      reusable: false,
      needs_confirmation: false,
      confirmed_at: null,
      version: 0
    }))
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("jobpilot_token", "t");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(body: object) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

describe("application eligibility section", () => {
  it("renders all three questions with nothing preselected", async () => {
    fetchMock.mockImplementation(() => respond(unanswered()));
    render(<ApplicationEligibility />);

    await waitFor(() => expect(screen.getAllByRole("radiogroup")).toHaveLength(3));
    // Not one option is checked — unanswered is its own state.
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("never preselects No", async () => {
    fetchMock.mockImplementation(() => respond(unanswered()));
    render(<ApplicationEligibility />);
    await waitFor(() => expect(screen.getAllByRole("radiogroup")).toHaveLength(3));
    for (const no of screen.getAllByRole("radio", { name: "No" })) {
      expect(no.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("offers answer-during-each-application as an explicit third choice", async () => {
    fetchMock.mockImplementation(() => respond(unanswered()));
    render(<ApplicationEligibility />);
    await waitFor(() =>
      expect(screen.getAllByRole("radio", { name: /answer during each application/i })).toHaveLength(3)
    );
  });

  it("sends only the field and the choice, never provenance", async () => {
    fetchMock.mockImplementation(() => respond(unanswered()));
    render(<ApplicationEligibility />);
    await waitFor(() => expect(screen.getAllByRole("radiogroup")).toHaveLength(3));

    await userEvent.click(screen.getAllByRole("radio", { name: "Yes" })[0]);

    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put).toBeTruthy();
    const body = JSON.parse(put![1].body as string);
    expect(Object.keys(body).sort()).toEqual(["answer", "field"]);
    for (const forbidden of ["source", "is_user_verified", "allow_auto_fill", "user_id", "last_verified_at"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("shows a confirmed answer as selected with its confirmation date", async () => {
    fetchMock.mockImplementation(() =>
      respond({
        answers: [
          {
            field: "work_authorization_us",
            prompt: "Authorized?",
            answer: "yes",
            answered: true,
            reusable: true,
            needs_confirmation: false,
            confirmed_at: "2026-01-15T00:00:00Z",
            version: 1
          }
        ]
      })
    );
    render(<ApplicationEligibility />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Yes" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByText(/confirmed/i)).toBeTruthy();
  });

  it("asks for reconfirmation when an answer is stale", async () => {
    fetchMock.mockImplementation(() =>
      respond({
        answers: [
          {
            field: "work_authorization_us",
            prompt: "Authorized?",
            answer: "yes",
            answered: true,
            reusable: false,
            needs_confirmation: true,
            confirmed_at: "2020-01-15T00:00:00Z",
            version: 1
          }
        ]
      })
    );
    render(<ApplicationEligibility />);
    await waitFor(() => expect(screen.getByText(/confirm this answer is still correct/i)).toBeTruthy());
  });

  it("explains that answers are reused and reviewable", async () => {
    fetchMock.mockImplementation(() => respond(unanswered()));
    render(<ApplicationEligibility />);
    await waitFor(() =>
      expect(screen.getByText(/reuse these answers for equivalent application questions/i)).toBeTruthy()
    );
  });
});
