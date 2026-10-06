/** One bounded, permissionless recovery pass per MV3 worker lifetime.
 * Broadcast responses are deliberately ignored: each surviving frame must
 * independently re-register through CONTENT_READY and Chrome MessageSender.
 */
export function createContentRegistrationRecovery(options: {
  candidateTabs(): Promise<Array<{ id?: number; url?: string }>>;
  signal(tabId: number): Promise<unknown>;
}): () => Promise<void> {
  let started = false;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (started) return Promise.resolve();
    started = true;
    inFlight = Promise.resolve().then(async () => {
      const tabs = await options.candidateTabs();
      const ids = new Set(tabs.filter((tab) =>
        Number.isInteger(tab.id) && tab.id! >= 0
        && /^https?:\/\//i.test(tab.url ?? "")
      ).map((tab) => tab.id!));
      await Promise.all([...ids].map(async (tabId) => {
        try { await options.signal(tabId); } catch { /* No receiver is normal. */ }
      }));
    }).catch(() => { /* A failed inventory is benign; never poll or inject. */ })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}
