import {
  type CloudProxyRouteContext,
  proxyCloudRequest,
} from "@/src/lib/cloud-proxy";

export function GET(request: Request, context: CloudProxyRouteContext) {
  return proxyCloudRequest(request, context);
}

export function POST(request: Request, context: CloudProxyRouteContext) {
  return proxyCloudRequest(request, context);
}

export function PATCH(request: Request, context: CloudProxyRouteContext) {
  return proxyCloudRequest(request, context);
}

export function DELETE(request: Request, context: CloudProxyRouteContext) {
  return proxyCloudRequest(request, context);
}
