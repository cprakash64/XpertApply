/** Per-content-context guard against late resolver responses from older retries. */
export interface EligibilityRun {
  id: string;
  createdAt: string;
}

export class ResolutionRunCoordinator {
  private sequence = 0;
  private active: EligibilityRun | null = null;

  begin(buildId: string, now = Date.now()): EligibilityRun {
    const run = {
      id: `${buildId}:${now.toString(36)}:${(++this.sequence).toString(36)}`,
      createdAt: new Date(now).toISOString()
    };
    this.active = run;
    return run;
  }

  current(): EligibilityRun | null {
    return this.active;
  }

  accepts(runId: string): boolean {
    return this.active?.id === runId;
  }
}
