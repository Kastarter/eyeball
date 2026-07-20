import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BillingCheckoutSuccessScreen } from "@/src/components/billing/billing-return-screen";
import {
  firstSearchParam,
  loadBillingReturnData,
} from "@/src/lib/billing-return";
import { isCloudMode } from "@/src/lib/runtime-config";

export const metadata: Metadata = { title: "Checkout complete" };

interface CheckoutSuccessPageProps {
  searchParams: Promise<{
    org?: string | string[];
    session?: string | string[];
  }>;
}

export default async function CheckoutSuccessPage({
  searchParams,
}: CheckoutSuccessPageProps) {
  if (!isCloudMode()) redirect("/demo/overview");
  const query = await searchParams;
  const organizationId = firstSearchParam(query.org);
  const checkoutSession = firstSearchParam(query.session);
  const data = await loadBillingReturnData(organizationId);
  if (!data.authenticated) {
    const nextQuery = new URLSearchParams();
    if (organizationId !== undefined) nextQuery.set("org", organizationId);
    if (checkoutSession !== undefined)
      nextQuery.set("session", checkoutSession);
    const suffix = nextQuery.size === 0 ? "" : `?${nextQuery.toString()}`;
    redirect(
      `/login?next=${encodeURIComponent(`/billing/checkout/success${suffix}`)}`,
    );
  }
  return (
    <BillingCheckoutSuccessScreen
      billing={data.billing}
      checkoutSessionPresent={checkoutSession !== undefined}
      organizationId={data.organizationId}
    />
  );
}
