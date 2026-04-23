export function safeOrder(sortBy: string | undefined, sortOrder: 'asc'|'desc', allowed: string[]) {
  if (!sortBy || !allowed.includes(sortBy)) return undefined;
  return { [sortBy]: sortOrder } as any;
}
