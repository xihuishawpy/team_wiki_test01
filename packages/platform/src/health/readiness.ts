export type DependencyStatus = 'ok' | 'unavailable' | 'not_configured' | 'unknown';

export interface ProbeResult {
  readonly status: DependencyStatus;
  readonly code?: string;
}

export interface DependencyProbe {
  readonly name: string;
  readonly required: boolean;
  readonly check: () => Promise<ProbeResult>;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'degraded' | 'not_ready';
  readonly checks: Readonly<Record<string, ProbeResult>>;
  readonly checked_at: string;
}

export class ReadinessChecker {
  public constructor(private readonly probes: readonly DependencyProbe[]) {}

  public async check(): Promise<ReadinessReport> {
    const checks: Record<string, ProbeResult> = {};
    let requiredUnavailable = false;
    let optionalUnavailable = false;

    await Promise.all(
      this.probes.map(async (probe) => {
        let result: ProbeResult;
        try {
          result = await probe.check();
        } catch {
          result = {
            status: 'unavailable',
            code: `${probe.name.toUpperCase()}_UNAVAILABLE`,
          };
        }

        checks[probe.name] = result;
        if (result.status !== 'ok') {
          if (probe.required) {
            requiredUnavailable = true;
          } else {
            optionalUnavailable = true;
          }
        }
      }),
    );

    return {
      status: requiredUnavailable ? 'not_ready' : optionalUnavailable ? 'degraded' : 'ready',
      checks,
      checked_at: new Date().toISOString(),
    };
  }
}

export function staticDependencyProbe(name: string, configured: boolean): DependencyProbe {
  return {
    name,
    required: false,
    check: () =>
      Promise.resolve(
        configured
          ? { status: 'unknown', code: `${name.toUpperCase()}_STATUS_UNKNOWN` }
          : { status: 'not_configured' },
      ),
  };
}
