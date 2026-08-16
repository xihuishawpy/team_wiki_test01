import { Module, type DynamicModule } from '@nestjs/common';

import type { ReadinessChecker } from '@team-wiki/platform';

import { HealthController, READINESS_CHECKER } from './health.controller.js';

@Module({})
export class PlatformHealthModule {
  public static register(readinessChecker: ReadinessChecker): DynamicModule {
    return {
      module: PlatformHealthModule,
      controllers: [HealthController],
      providers: [{ provide: READINESS_CHECKER, useValue: readinessChecker }],
    };
  }
}
