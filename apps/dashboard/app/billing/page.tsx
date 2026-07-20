import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BillingLandingScreen } from "@/src/components/billing/billing-return-screen";
import {
  firstSearchParam,
  loadBillingReturnData,
} from "@/src/lib/billing-return";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Organization billing" };

interface BillingPageProps {
  searchParams: Promise<{ org?: string | string[] }>;
}

export default async function BillingPage({ searchParams }: BillingPageProps) {
  if (!isCloudMode()) redirect("/demo/overview");
  const organizationId = firstSearchParam((await searchParams).org);
  const data = await loadBillingReturnData(organizationId);
  if (!data.authenticated) {
    const suffix =
      organizationId === undefined
        ? ""
        : `?org=${encodeURIComponent(organizationId)}`;
    redirect(`/login?next=${encodeURIComponent(`/billing${suffix}`)}`);
  }
  return (
    <BillingLandingScreen
      billing={data.billing}
      organizationId={data.organizationId}
    />
  );
}
