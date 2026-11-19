import { Prisma } from '@prisma/client';
import { PoolConfiguration } from './control-pool.configuration';

type IdentityClient = { $transaction: (work: (tx: Prisma.TransactionClient) => Promise<void>, options: { timeout: number; maxWait: number }) => Promise<void> };
/** No third client, application-table reads, writes, or raw driver errors. */
export async function verifyPoolIdentity(client: IdentityClient, expected: PoolConfiguration) {
  try {
    await client.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const rows = await tx.$queryRaw<Array<{ database: string; role: string; session: string; elevated: boolean }>>`
        SELECT current_database()::text AS database, current_user::text AS role, session_user::text AS session,
          (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls) AS elevated FROM pg_roles WHERE rolname = current_user`;
      if (rows.length !== 1 || rows[0].database !== expected.database || rows[0].role !== expected.role || rows[0].session !== expected.role ||
          (expected.mode === 'clean-rc-v1' && rows[0].elevated)) throw new Error('Identity mismatch');
    }, { timeout: 1000, maxWait: 500 });
  } catch { throw new Error('Control-pool database identity verification failed. No activation or fallback permitted.'); }
}
