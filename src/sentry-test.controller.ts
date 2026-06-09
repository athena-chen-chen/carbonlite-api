import { Controller, Get, NotFoundException } from '@nestjs/common';

@Controller('debug')
export class SentryTestController {
  @Get('sentry')
  triggerError() {
    if (process.env.NODE_ENV !== 'development') {
      throw new NotFoundException('Not found');
    }

    throw new Error('Sentry Test Error');
  }
}
