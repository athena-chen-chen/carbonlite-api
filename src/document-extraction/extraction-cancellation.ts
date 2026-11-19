/** Best-effort, process-local cancellation only. Durable dispatch and result
 * fences remain authoritative across workers and commit/registration races. */
const attempts = new Map<string, { organizationId: string; realData: boolean; controller: AbortController }>();
export function registerExtractionAttempt(operationId: string, organizationId: string, realData: boolean) {
  const controller = new AbortController();
  attempts.set(operationId, { organizationId, realData, controller });
  return { signal: controller.signal, release: () => { attempts.delete(operationId); } };
}
export function cancelExtractionAttempts(organizationId: string, realDataOnly: boolean) {
  for (const attempt of attempts.values()) if (attempt.organizationId === organizationId && (!realDataOnly || attempt.realData)) attempt.controller.abort();
}
