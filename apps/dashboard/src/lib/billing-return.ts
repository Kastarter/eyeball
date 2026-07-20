import { CloudApiError, type CloudBillingView } from "./cloud-api";
import { loadCloudBilling, loadCloudSession } from "./cloud-server";

export interface BillingReturnData {
  authenticated: boolean;
  billing?: CloudBillingView;
  organizationId?: string;
}

export function firstSearchParam(
  value: string | readonly string[] | undefined,
): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const normalized = candidate?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

export async function loadBillingReturnData(
  organizationId: string | undefined,
): Promise<BillingReturnData> {
  if (organizationId === undefined) {
    return { authenticated: (await loadCloudSession()) !== undefined };
  }
  try {
    return {
      authenticated: true,
      billing: await loadCloudBilling(organizationId),
      organizationId,
    };
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401) {
      return { authenticated: false };
    }
    if (error instanceof CloudApiError && error.status === 404) {
      return { authenticated: true };
    }
    throw error;
  }
}
