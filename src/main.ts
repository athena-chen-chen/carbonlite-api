
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

import { ValidationPipe } from '@nestjs/common';
async function bootstrap() {
const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.setGlobalPrefix('api');
 app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads',
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  const PORT = process.env.PORT ? Number(process.env.PORT) : 3333;
  await app.listen(PORT);
  const url = await app.getUrl();
  console.log('[CarbonLite API] Listening on', url);
}
bootstrap();
