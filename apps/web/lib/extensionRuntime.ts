import { chromeExtensionId } from "@/lib/siteConfig";

export const EXTERNAL_PING = "XPERTAPPLY_EXTERNAL_PING";
export const EXTERNAL_SESSION_END = "XPERTAPPLY_EXTERNAL_SESSION_END";

export type BrowserExtensionInfo = {
  installed: true;
  version: string;
  protocolVersion: number;
  capabilities: string[];
};

type ExternalRuntime = {
  lastError?: { message?: string };
  sendMessage: (
    extensionId: string,
    message: { type: string; reason?: string },
    callback: (response: unknown) => void
  ) => void;
};

export type ExternalAttempt =
  | { kind: "response"; response: unknown }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "timeout" };

export type ExternalChannel = {
  request(message: { type: string; reason?: string }, timeoutMs: number): Promise<ExternalAttempt>;
};

function receiverIsUnavailable(message: string): boolean {
  return /could not establish connection|receiving end does not exist|no such extension/i.test(message);
}

function openExternalChannel(): ExternalChannel | null {
  if (typeof window === "undefined") return null;
  const extensionId = chromeExtensionId();
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: ExternalRuntime };
  }).chrome?.runtime;
  if (!extensionId || !runtime || typeof runtime.sendMessage !== "function") return null;
  const sendMessage = runtime.sendMessage.bind(runtime);
  return {
    request(message, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: ExternalAttempt) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(result);
        };
        const timer = window.setTimeout(() => finish({ kind: "timeout" }), Math.max(1, timeoutMs));
        try {
          sendMessage(extensionId, message, (response) => {
            const error = runtime.lastError?.message;
            if (error) {
              finish({ kind: receiverIsUnavailable(error) ? "unavailable" : "error" });
              return;
            }
            finish({ kind: "response", response });
          });
        } catch {
          finish({ kind: "error" });
        }
      });
    }
  };
}

export function parseExternalPingResponse(response: unknown): BrowserExtensionInfo | null {
  if (!response || typeof response !== "object") return null;
  const outer = response as { ok?: unknown; info?: unknown };
  if (outer.ok !== true || Object.keys(outer).sort().join(",") !== "info,ok"
    || !outer.info || typeof outer.info !== "object") return null;
  const info = outer.info as Partial<BrowserExtensionInfo>;
  if (info.installed !== true || typeof info.version !== "string"
    || !Number.isInteger(info.protocolVersion) || !Array.isArray(info.capabilities)
    || !info.capabilities.every((capability) => typeof capability === "string")
    || Object.keys(info).sort().join(",") !== "capabilities,installed,protocolVersion,version") return null;
  return info as BrowserExtensionInfo;
}

export async function connectExternalExtension(
  timeoutMs: number
): Promise<
  | { kind: "present"; channel: ExternalChannel; info: BrowserExtensionInfo }
  | { kind: "absent" }
  | { kind: "failed" | "timeout" }
> {
  const channel = openExternalChannel();
  if (!channel) return { kind: "absent" };
  const attempt = await channel.request({ type: EXTERNAL_PING }, timeoutMs);
  if (attempt.kind === "unavailable") return { kind: "absent" };
  if (attempt.kind === "timeout") return { kind: "timeout" };
  if (attempt.kind !== "response") return { kind: "failed" };
  const info = parseExternalPingResponse(attempt.response);
  return info ? { kind: "present", channel, info } : { kind: "failed" };
}
