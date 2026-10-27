"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ScoringStatus } from "@/lib/api";

export function scoringMessage(status?: ScoringStatus["status"]): string {
  switch (status) {
    case "pending": case "processing": return "Fit scoring is processing. Your saved changes are accepted.";
    case "complete": return "Fit scoring complete.";
    case "failed": return "Fit scoring failed. Your saved changes are preserved.";
    case "superseded": return "This scoring request was superseded by newer changes.";
    case "canceled": return "Fit scoring canceled.";
    default: return "";
  }
}

/** One actor-local GET at a time, even when no cards are visible. Never repeats intake. */
export function useScoringStatus(initial?: ScoringStatus, onSettled?: () => void | Promise<unknown>) {
  const seed = `${initial?.enabled}:${initial?.status}:${initial?.intent_id}`;
  const [observed, setObserved] = useState<{ seed: string; status: ScoringStatus["status"] }>();
  const status = observed?.seed === seed ? observed.status : initial?.status;
  const settled = useRef(onSettled);
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
  useEffect(() => {
    if (!initial?.enabled || !["pending", "processing"].includes(initial.status)) return;
    let live = true;
    let finished = false;
    let inFlight = false;
    let delay = 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const schedule = () => {
      if (live && !finished && !document.hidden) timer = setTimeout(tick, delay + Math.floor(Math.random() * 250));
    };
    async function tick() {
      if (!live || finished || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await api<ScoringStatus>("/jobs/scoring-status", { signal: abort.signal });
        if (!live) return;
        setObserved({ seed, status: next.status });
        delay = 5000;
        if (!next.enabled || !["pending", "processing"].includes(next.status)) {
          finished = true;
          await settled.current?.();
        }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.code === "auth_expired")) {
          finished = true;
        } else {
          delay = Math.min(30000, delay * 2);
        }
      } finally {
        inFlight = false;
        schedule();
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!inFlight) schedule();
    };
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [seed, initial?.enabled, initial?.status, initial?.intent_id]);
  return { status, message: initial?.enabled ? scoringMessage(status) : "" };
}
