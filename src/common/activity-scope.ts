import { ActivityType } from '@prisma/client';

export function getActivityScope(type: ActivityType): string {
  switch (type) {
    case ActivityType.DIESEL:
    case ActivityType.GASOLINE:
    case ActivityType.NATURAL_GAS:
      return 'Scope 1';

    case ActivityType.ELECTRICITY:
      return 'Scope 2';

    case ActivityType.AIR_TRAVEL:
    case ActivityType.HOTEL:
    case ActivityType.SHIPPING:
      return 'Scope 3';

    default:
      return 'Unknown';
  }
}