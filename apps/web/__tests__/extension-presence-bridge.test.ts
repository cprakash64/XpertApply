import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_EXTENSION_PROTOCOL, detectExtensionState, detectFirstPartyBridge } from "@/lib/autoApply";

const READY_INFO = {
  installed: true as const,
  version: "0.2.0",
  protocolVersion: MIN_EXTENSION_PROTOCOL,
  capabilities: ["fill", "upload"]
};

function installBridgeResponder(info = READY_INFO) {
  return vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    const ping = message as { type?: string; requestId?: string };
    if (ping.type !== "XPERTAPPLY_EXTENSION_PRESENCE_PING") return;
    queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: {
        source: "jobpilot-extension",
        type: "XPERTAPPLY_EXTENSION_PRESENCE_READY",
        requestId: ping.requestId,
        info
      }
    })));
  });
}

describe("first-party extension presence bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("detects an unpacked extension without knowing its Chrome ID", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_ID", "gnibjomjfdobadlockphjiibbpmiehcj");
    vi.stubGlobal("chrome", undefined);
    const post = installBridgeResponder();
    await expect(detectExtensionState(100)).resolves.toMatchObject({
      status: "connected", present: true, outdated: false, info: READY_INFO
    });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      source: "jobpilot-web",
      type: "XPERTAPPLY_EXTENSION_PRESENCE_PING"
    }), window.location.origin);
  });

  it("is replayable across repeated checks and page reload logic", async () => {
    installBridgeResponder();
    await expect(detectFirstPartyBridge(100)).resolves.toEqual(READY_INFO);
    await expect(detectFirstPartyBridge(100)).resolves.toEqual(READY_INFO);
  });

  it("ignores an uncorrelated ready event and times out to not installed", async () => {
    vi.stubGlobal("chrome", undefined);
    vi.spyOn(window, "postMessage").mockImplementation(() => {
      queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "jobpilot-extension",
          type: "XPERTAPPLY_EXTENSION_PRESENCE_READY",
          requestId: "wrong-request",
          info: READY_INFO
        }
      })));
    });
    await expect(detectExtensionState(10)).resolves.toEqual({ status: "not_installed", present: false });
  });

  it("reports an incompatible build without exposing protocol integers to UI", async () => {
    installBridgeResponder({ ...READY_INFO, protocolVersion: MIN_EXTENSION_PROTOCOL - 1 });
    await expect(detectExtensionState(100)).resolves.toMatchObject({
      status: "incompatible", present: true, outdated: true
    });
  });
});
