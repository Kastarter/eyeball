import type { Metadata } from "next";
import type { WebhookEndpointDrawerTab } from "@/src/components/webhooks/webhook-endpoint-drawer";
import { WebhooksScreen } from "@/src/components/webhooks/webhooks-screen";
import { getCatalogWebhookTriggerOptions } from "@/src/lib/catalog";

export const metadata: Metadata = { title: "Webhooks" };

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
  const initialNewEndpointOpen = firstQueryValue(query.new) === "true";
  const endpoint = firstQueryValue(query.endpoint)?.trim();
  const tabValue = firstQueryValue(query.tab);
  const initialTab: WebhookEndpointDrawerTab =
    tabValue === "deliveries" ? "deliveries" : "settings";

  return (
    <WebhooksScreen
      catalogTriggerOptions={getCatalogWebhookTriggerOptions()}
      initialNewEndpointOpen={initialNewEndpointOpen}
      {...(initialNewEndpointOpen ||
      endpoint === undefined ||
      endpoint.length === 0
        ? {}
        : { initialSelectedEndpoint: endpoint })}
      initialTab={initialTab}
      project={project}
    />
  );
}
