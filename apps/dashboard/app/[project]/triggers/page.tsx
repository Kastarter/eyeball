import type { Metadata } from "next";
import { TriggersScreen } from "@/src/components/triggers/triggers-screen";
import { getCatalogTriggerSubscriptionOptions } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Triggers" };

function firstQueryValue(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ project: string }>;
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const [{ project }, query] = await Promise.all([params, searchParams]);
  const initialNewSubscriptionOpen = firstQueryValue(query.new) === "true";
  const subscription = firstQueryValue(query.subscription)?.trim();
  const requestedView = firstQueryValue(query.view);
  const hasSelectedSubscription =
    !initialNewSubscriptionOpen &&
    subscription !== undefined &&
    subscription.length > 0;
  const initialView =
    !initialNewSubscriptionOpen &&
    !hasSelectedSubscription &&
    requestedView === "events"
      ? "events"
      : "subscriptions";

  return (
    <TriggersScreen
      catalogTriggerOptions={getCatalogTriggerSubscriptionOptions()}
      initialNewSubscriptionOpen={initialNewSubscriptionOpen}
      initialView={initialView}
      {...(initialNewSubscriptionOpen ||
      subscription === undefined ||
      subscription.length === 0
        ? {}
        : { initialSelectedSubscription: subscription })}
      project={project}
    />
  );
}
