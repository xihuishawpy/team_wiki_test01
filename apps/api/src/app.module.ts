import { Module, type DynamicModule } from '@nestjs/common';

import type { ReadinessChecker } from '@team-wiki/platform';

import { PlatformHealthModule } from './platform-health.module.js';

@Module({})
export class AppModule {
  public static register(readinessChecker: ReadinessChecker): DynamicModule {
    return {
      module: AppModule,
      imports: [PlatformHealthModule.register(readinessChecker)],
    };
  }
}
