import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  validationErrorsFromDetails
} from "@/lib/api";

function response(body: unknown, status: number) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "request-123" }
  });
}

describe("FastAPI validation error normalization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts field locations and useful messages without submitted values", () => {
    expect(
      validationErrorsFromDetails([
        {
          loc: ["body", "portfolio_url"],
          msg: "Value error, Enter a complete web address."
        },
        {
          loc: ["body", "additional_links", 0, "url"],
          msg: "URL scheme should be 'http' or 'https'"
        }
      ])
    ).toEqual({
      fieldErrors: {
        portfolio_url: "Enter a complete web address.",
        "additional_links.0.url": "URL scheme should be 'http' or 'https'"
      },
      formError: undefined
    });
  });

  it("keeps multiple field errors on one 422 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(
        {
          detail: [
            { loc: ["body", "portfolio_url"], msg: "Invalid portfolio URL" },
            { loc: ["body", "github_url"], msg: "Invalid GitHub URL" }
          ]
        },
        422
      )
    );

    const error = await api("/profile", { method: "PATCH", body: "{}" }).catch(
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "validation",
      message: "Some fields need attention before this can be saved.",
      fieldErrors: {
        portfolio_url: "Invalid portfolio URL",
        github_url: "Invalid GitHub URL"
      },
      requestId: "request-123"
    });
  });

  it("preserves a non-field model validation reason as a form error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ detail: [{ loc: ["body"], msg: "Value error, Invalid field combination" }] }, 422)
    );

    const error = await api("/profile", { method: "PATCH", body: "{}" }).catch(
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({
      fieldErrors: {},
      formError: "Invalid field combination"
    });
  });

  it("keeps non-validation server errors as concise form-level failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({ detail: "Profile service is temporarily unavailable." }, 503)
    );

    await expect(api("/profile", { method: "PATCH", body: "{}" })).rejects.toMatchObject({
      code: "service_unavailable",
      status: 503,
      message: "Profile service is temporarily unavailable.",
      fieldErrors: {}
    });
  });

  it("falls back safely for malformed non-JSON error responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response("<html>proxy exploded</html>", 502));

    await expect(api("/profile", { method: "PATCH", body: "{}" })).rejects.toMatchObject({
      code: "server_error",
      status: 502,
      message: "Request failed with 502",
      fieldErrors: {}
    });
  });
});
