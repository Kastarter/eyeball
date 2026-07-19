import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout from "@/app/layout";
import HomePage from "@/app/page";
import {
  DX_CODE,
  RESTAURANT_TRANSCRIPT,
  SELECTED_HEADLINE,
} from "@/src/content";
import { CATALOG_STATS } from "@/src/landing-data";

describe("landing page rendering", () => {
  it("renders the hero and three-step developer flow", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    expect(markup).toContain(SELECTED_HEADLINE);
    expect(markup).toContain("Connect");
    expect(markup).toContain("Get tools");
    expect(markup).toContain("Execute");
    expect(markup).toContain("eyeball.connections.create");
    expect(markup).toContain("eyeball.tools.get");
    expect(markup).toContain("eyeball.tools.execute");
    expect(DX_CODE).toContain("// 1 — Connect an end user");
    expect(DX_CODE).toContain("// 2 — Get tools for your framework");
    expect(DX_CODE).toContain("// 3 — Execute through eyeball");
  });

  it("renders the real transcript lines and requested tool stages", () => {
    const markup = renderToStaticMarkup(<HomePage />);

    for (const turn of RESTAURANT_TRANSCRIPT) {
      expect(markup).toContain(turn.kind === "tool" ? turn.tool : turn.text);
    }
    expect(markup).toContain("check_availability");
    expect(markup).toContain("create_reservation");
    expect(markup).toContain("send_email");
  });

  it("renders live catalog counts and semantic landmarks", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <HomePage />
      </RootLayout>,
    );

    expect(markup).toContain(String(CATALOG_STATS.roadmapProviders));
    expect(markup).toContain(String(CATALOG_STATS.implementedManifests));
    expect(markup).toContain(String(CATALOG_STATS.capabilities));
    expect(markup).toContain("Skip to content");
    expect(markup).toContain("<header");
    expect(markup).toContain("<main");
    expect(markup).toContain("<footer");
  });
});
