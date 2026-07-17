import type { FetchImplementation } from "@eyeball/core";
import type {
  PieceExecutionBoundary,
  PieceExecutionBoundaryContext,
  PieceFetchRoute,
} from "./types.js";

function routeForUrl(
  url: URL,
  routes: readonly PieceFetchRoute[],
): PieceFetchRoute | undefined {
  return routes.find(
    (route) => new URL(route.fromOrigin).origin === url.origin,
  );
}

/** Rewrites only an explicitly allowlisted provider origin. */
export function rewritePieceUrl(
  input: string | URL,
  routes: readonly PieceFetchRoute[],
): string {
  const source = new URL(input);
  const route = routeForUrl(source, routes);
  if (route === undefined) {
    return source.toString();
  }

  const target = new URL(route.toBaseUrl);
  const targetPrefix = target.pathname.replace(/\/$/u, "");
  target.pathname = `${targetPrefix}${source.pathname}`;
  target.search = source.search;
  target.hash = source.hash;
  return target.toString();
}

/**
 * Builds the transport seam used by framework helpers that consult global fetch.
 * Requests to any origin not present in `routes` are delegated unchanged.
 */
export function createRoutedFetch(
  fetchImpl: FetchImplementation,
  routes: readonly PieceFetchRoute[],
): FetchImplementation {
  const routedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const sourceUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : input;
    const rewritten = rewritePieceUrl(sourceUrl, routes);

    if (rewritten === new URL(sourceUrl).toString()) {
      return fetchImpl(input, init);
    }
    if (!(input instanceof Request)) {
      return fetchImpl(rewritten, init);
    }

    const method = init?.method ?? input.method;
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await input.clone().arrayBuffer();
    const requestBody = init?.body ?? body;
    return fetchImpl(rewritten, {
      method,
      headers: init?.headers ?? input.headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      redirect: init?.redirect ?? input.redirect,
      signal: init?.signal ?? input.signal,
    });
  };
  return routedFetch as FetchImplementation;
}

let globalFetchTail: Promise<void> = Promise.resolve();

/**
 * Activepieces helpers currently reach global fetch. Serialize bridge boundaries
 * and restore the mutation so two bridge executions cannot overlap their routes.
 * Unrelated code still shares this process-global value, which is why production
 * execution requires an isolated worker.
 */
async function withScopedGlobalFetch<T>(
  routedFetch: FetchImplementation,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = globalFetchTail;
  let release: () => void = () => undefined;
  globalFetchTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = routedFetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
    release();
  }
}

/** Runs an action inside both the fetch seam and an optional Node-client seam. */
export function runInsidePieceBoundary<T>(
  context: PieceExecutionBoundaryContext,
  boundary: PieceExecutionBoundary | undefined,
  routedFetch: FetchImplementation,
  operation: () => Promise<T>,
): Promise<T> {
  return withScopedGlobalFetch(routedFetch, () =>
    boundary === undefined ? operation() : boundary.run(context, operation),
  );
}
