import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('sentry-test-error')
export class SentryTestController {
  @Get()
  triggerError() {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException('Not found');
    }

    throw new Error('CarbonLite backend Sentry test error');
  }
}
