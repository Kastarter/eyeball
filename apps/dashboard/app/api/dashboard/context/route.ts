import { handleDashboardContextPost } from "@/src/lib/dashboard-context-route";

export function POST(request: Request): Promise<Response> {
  return handleDashboardContextPost(request);
}
