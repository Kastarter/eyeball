import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolkitSearchFailure } from "./toolkit-catalog-browser";

describe("ToolkitSearchFailure", () => {
  it("renders an accessible retry without claiming a trustworthy zero-result set", () => {
    const markup = renderToStaticMarkup(
      <ToolkitSearchFailure
        hasDirectMatches={false}
        message="Catalog search returned an invalid response."
        onRetry={() => undefined}
        query="send email"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Tool search could not be completed");
    expect(markup).toContain("send email");
    expect(markup).toContain("Retry search");
    expect(markup).not.toContain("No toolkits match");
  });

  it("keeps direct local metadata matches visible while reporting the failure", () => {
    const markup = renderToStaticMarkup(
      <ToolkitSearchFailure
        hasDirectMatches
        message="Catalog search failed with HTTP 503."
        onRetry={() => undefined}
        query="gmail"
      />,
    );

    expect(markup).toContain("catalog_search_failed");
    expect(markup).toContain("Local toolkit metadata matches remain available");
  });
});
