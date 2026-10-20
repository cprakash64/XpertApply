import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, PAYLOAD_TOO_LARGE_MESSAGE } from "@/lib/api";

/**
 * A 413 reaches the client from two different places, and only one of them
 * speaks JSON:
 *
 *  - the API, when an upload exceeds MAX_UPLOAD_BYTES — a JSON `detail`;
 *  - the reverse proxy, when the request exceeds its own body limit — an HTML
 *    error page the request never gets past.
 *
 * The client deliberately refuses to render an HTML proxy page, so before this
 * mapping the second case surfaced as "Request failed with 413".
 */
function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function htmlResponse(status: number) {
  return new Response(
    "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n" +
      "<body><center><h1>413 Request Entity Too Large</h1></center>" +
      "<hr><center>nginx/1.24.0 (Ubuntu)</center></body>\r\n</html>",
    { status, headers: { "Content-Type": "text/html" } }
  );
}

/** Perform the upload and return the ApiError it must reject with. */
async function uploadError(): Promise<ApiError> {
  try {
    await api("/profile/import/file", { method: "POST" });
  } catch (caught) {
    if (caught instanceof ApiError) return caught;
    throw caught;
  }
  throw new Error("expected the request to reject");
}

describe("413 Payload Too Large handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turns an edge-generated HTML 413 into an actionable message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(413));

    const error = await uploadError();

    expect(error.code).toBe("payload_too_large");
    expect(error.status).toBe(413);
    expect(error.message).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(error.message).not.toContain("Request failed with");
  });

  it("never renders the proxy's HTML body or server banner", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(413));

    const error = await uploadError();

    expect(error.message).not.toContain("<html>");
    expect(error.message).not.toContain("nginx");
  });

  it("prefers the API's own detail when the 413 carries one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Uploaded file is too large. The limit is 5MB." }, 413)
    );

    const error = await uploadError();

    expect(error.code).toBe("payload_too_large");
    expect(error.message).toBe("Uploaded file is too large. The limit is 5MB.");
  });

  it("does not mark a 413 retryable — the same file is the same size", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(413));

    const error = await uploadError();

    expect(error.retryable).toBe(false);
  });

  it("leaves other statuses classified as before", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail: "nope" }, 415));

    const error = await uploadError();

    expect(error.code).toBe("request_failed");
    expect(error.message).toBe("nope");
  });
});
