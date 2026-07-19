export type DashboardMode = "cloud" | "demo";

export type DashboardDataSource =
  | "catalog"
  | "cloud-control"
  | "demo"
  | "executor";

export type DashboardFeature =
  | "apiKeys"
  | "audit"
  | "auth"
  | "connections"
  | "executions"
  | "organizations"
  | "toolkits"
  | "voiceAgents";

export interface RuntimeEnvironment {
  readonly [name: string]: string | undefined;
  readonly EYEBALL_CLOUD_URL?: string;
  readonly NEXT_PUBLIC_EYEBALL_MODE?: string;
}

export interface DashboardRuntimeConfig {
  cloudUrlConfigured: boolean;
  mode: DashboardMode;
}

const cloudFeatures = new Set<DashboardFeature>([
  "apiKeys",
  "audit",
  "auth",
  "connections",
  "organizations",
]);

export function dashboardRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
): DashboardRuntimeConfig {
  return {
    cloudUrlConfigured: Boolean(environment.EYEBALL_CLOUD_URL?.trim()),
    mode:
      environment.NEXT_PUBLIC_EYEBALL_MODE?.trim().toLowerCase() === "cloud"
        ? "cloud"
        : "demo",
  };
}

export function dashboardMode(
  environment: RuntimeEnvironment = process.env,
): DashboardMode {
  return dashboardRuntimeConfig(environment).mode;
}

export function dashboardDataSource(
  feature: DashboardFeature,
  environment: RuntimeEnvironment = process.env,
): DashboardDataSource {
  const mode = dashboardMode(environment);
  if (feature === "toolkits") return "catalog";
  if (feature === "executions" || feature === "voiceAgents") return "executor";
  if (mode === "cloud" && cloudFeatures.has(feature)) return "cloud-control";
  if (feature === "connections") return "executor";
  return "demo";
}

export function isCloudMode(
  environment: RuntimeEnvironment = process.env,
): boolean {
  return dashboardMode(environment) === "cloud";
}
