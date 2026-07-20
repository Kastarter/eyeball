import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BillingCheckoutCancelScreen } from "@/src/components/billing/billing-return-screen";
import {
  firstSearchParam,
  loadBillingReturnData,
} from "@/src/lib/billing-return";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Checkout canceled" };

interface CheckoutCancelPageProps {
  searchParams: Promise<{ org?: string | string[] }>;
}

export default async function CheckoutCancelPage({
  searchParams,
}: CheckoutCancelPageProps) {
  if (!isCloudMode()) redirect("/demo/overview");
  const organizationId = firstSearchParam((await searchParams).org);
  const data = await loadBillingReturnData(organizationId);
  if (!data.authenticated) {
    const suffix =
      organizationId === undefined
        ? ""
        : `?org=${encodeURIComponent(organizationId)}`;
    redirect(
      `/login?next=${encodeURIComponent(`/billing/checkout/cancel${suffix}`)}`,
    );
  }
  return (
    <BillingCheckoutCancelScreen
      billing={data.billing}
      organizationId={data.organizationId}
    />
  );
}
