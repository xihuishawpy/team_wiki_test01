import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  DependencyStatus,
  ProbeResult,
  ReadinessChecker,
  ReadinessReport,
} from '@team-wiki/platform';

export const READINESS_CHECKER = Symbol('READINESS_CHECKER');

interface DependencyStatusResponse {
  readonly status: 'ok' | 'degraded' | 'unavailable' | 'disabled' | 'unconfigured';
  readonly error_code?: string;
}

interface ReadinessResponse {
  readonly status: 'ready' | 'degraded';
  readonly database: DependencyStatusResponse;
  readonly github: DependencyStatusResponse;
  readonly model: DependencyStatusResponse;
}

interface ErrorResponse {
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
}

function dependencyResponse(result: ProbeResult | undefined): DependencyStatusResponse {
  const statusMap: Record<DependencyStatus, DependencyStatusResponse['status']> = {
    ok: 'ok',
    unavailable: 'unavailable',
    not_configured: 'unconfigured',
    unknown: 'degraded',
  };
  if (!result) {
    return { status: 'unavailable', error_code: 'DEPENDENCY_PROBE_MISSING' };
  }
  return {
    status: statusMap[result.status],
    ...(result.code ? { error_code: result.code } : {}),
  };
}

function requiredFailure(report: ReadinessReport): ProbeResult | undefined {
  return [report.checks.database, report.checks.migrations].find(
    (result) => result?.status !== 'ok',
  );
}

@Controller('health')
export class HealthController {
  public constructor(
    @Inject(READINESS_CHECKER) private readonly readinessChecker: ReadinessChecker,
  ) {}

  @Get('live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  public async ready(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReadinessResponse | ErrorResponse> {
    const report = await this.readinessChecker.check();
    if (report.status === 'not_ready') {
      void reply.status(503);
      const failure = requiredFailure(report);
      return {
        code: failure?.code ?? 'REQUIRED_DEPENDENCY_UNAVAILABLE',
        message: 'Required dependency unavailable.',
        request_id: request.id,
      };
    }
    return {
      status: report.status,
      database: dependencyResponse(report.checks.database),
      github: dependencyResponse(report.checks.github),
      model: dependencyResponse(report.checks.model),
    };
  }
}
