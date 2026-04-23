
// import { AuthModule } from './auth/auth.module';
// import { FactorsModule } from './factors/factors.module';
// import { FuelRecordsModule } from './fuel-records/fuel-records.module'; // if you split emissions into its own module
// import { FacilitiesModule } from './facilities/facilities.module';
// import { AnalyticsModule } from './analytics/analytics.module';
// import { EmissionsModule } from './emissions/emissions.module'; // if using "emissions" naming

// import { JwtModule } from '@nestjs/jwt';
// JwtModule.register({
//   secret: process.env.JWT_SECRET || 'dev-secret',
//   signOptions: { expiresIn: '7d' },
// })
// @Module({
//   imports: [
//     AuthModule,
//     FactorsModule,
//     FacilitiesModule,
//     AnalyticsModule,
//     // choose one depending on your folder naming:
//     EmissionsModule, // if you built emissions/* as its own module
//     // or FuelRecordsModule,
//   ],
// })
// export class AppModule {}


// src/app.module.ts
// import { Module } from '@nestjs/common';
// import { AuthModule } from './auth/auth.module';

// import { ConfigModule } from '@nestjs/config';

// import { HealthController } from './health.controller';
// @Module({
//    imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule],
//   controllers: [HealthController],
//   //imports: [AuthModule],
// })
// export class AppModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ActivityDataModule } from './activity-data/activity-data.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthController } from './health.controller';
import { ConversionFactorsModule } from './conversion-factors/conversion-factors.module';
import { DocumentsModule } from './documents/documents.module';
import { DocumentExtractionModule } from './document-extraction/document-extraction.module';

@Module({
  imports: [
    PrismaModule,
    ActivityDataModule,
    MetricsModule,
ConversionFactorsModule,
DocumentsModule,
DocumentExtractionModule
  ],
  controllers: [HealthController],
})
export class AppModule {
}