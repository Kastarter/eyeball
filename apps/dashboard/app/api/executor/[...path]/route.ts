import {
  type ExecutorProxyRouteContext,
  proxyExecutorRequest,
} from "@/src/lib/executor-proxy";

export function GET(
  request: Request,
  context: ExecutorProxyRouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}

export function POST(
  request: Request,
  context: ExecutorProxyRouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}

export function PATCH(
  request: Request,
  context: ExecutorProxyRouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}

export function DELETE(
  request: Request,
  context: ExecutorProxyRouteContext,
): Promise<Response> {
  return proxyExecutorRequest(request, context);
}
