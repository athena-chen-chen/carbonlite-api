import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception?.message || 'Internal Server Error';

    res.status(status).json({
      ok: false,
      code: exception?.code || 'ERR_GENERIC',
      message,
      path: req.url,
      ts: new Date().toISOString(),
    });
  }
}
