import { ApertureMark } from "@/src/components/aperture-mark";
import { CodeSample } from "@/src/components/code-sample";
import { ArrowIcon, GitHubIcon } from "@/src/components/icons";
import { SiteFooter, SiteHeader } from "@/src/components/site-chrome";
import { TranscriptReplay } from "@/src/components/transcript-replay";
import { SELECTED_HEADLINE } from "@/src/content";
import { CATALOG_STATS, PROVIDER_GROUPS } from "@/src/landing-data";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const PILLARS = [
  {
    number: "01",
    title: "Framework-Native Output",
    copy: "Ask once for canonical tools. Get Anthropic, OpenAI, AI SDK, or MCP shapes without changing how execution works.",
    signal: "SDK · MCP · model formats",
  },
  {
    number: "02",
    title: "Auth Done Right",
    copy: "End users connect their own accounts. Project and user scope follows every tool from discovery through execution.",
    signal: "user-scoped connections",
  },
  {
    number: "03",
    title: "Beyond SaaS CRUD",
    copy: "Build call and realtime voice-agent flows, and retrieve social data alongside the business systems wrappers already cover.",
    signal: "voice · social · real world",
  },
  {
    number: "04",
    title: "Search Before Context",
    copy: "Find the relevant few tools for each step instead of pushing a thousand schemas through your agent’s context window.",
    signal: "catalog-aware selection",
  },
] as const;

export default function HomePage() {
  return (
    <div className="landing-shell">
      <SiteHeader />
      <main id="main">
        <section aria-labelledby="hero-title" className="hero">
          <div aria-hidden="true" className="hero-atmosphere">
            <div className="hero-grid" />
            <div className="hero-glow" />
            <div className="hero-reticle">
              <span className="hero-reticle__ring" />
              <ApertureMark className="hero-aperture" size={184} />
            </div>
            <div className="hero-scan" />
          </div>
          <div className="hero__inner">
            <div className="hero-copy">
              <p className="eyebrow">
                <span aria-hidden="true" className="eyebrow__signal" />
                The open tool layer for agents
              </p>
              <h1 id="hero-title">{SELECTED_HEADLINE}</h1>
              <p className="hero-copy__lede">
                Typed, authenticated tools for AI agents—email, calling,
                messaging, ERPs, and social data—with each end user connected to
                their own accounts.
              </p>
              <div className="hero-actions">
                <a className="button button--primary" href="/docs">
                  Read the docs
                  <ArrowIcon />
                </a>
                <button
                  className="button button--secondary button--disabled"
                  disabled
                  title="Public repository link coming soon"
                  type="button"
                >
                  <GitHubIcon />
                  GitHub soon
                </button>
              </div>
              <p className="hero-copy__proof">
                <span>One catalog</span>
                <span>One auth boundary</span>
                <span>One execution record</span>
              </p>
            </div>
            <div className="hero-code">
              <div aria-hidden="true" className="hero-code__index">
                01 / DX
              </div>
              <CodeSample />
              <p className="hero-code__caption">
                The same canonical call routes through the SDK or MCP.
              </p>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="demo-title"
          className="section section--demo"
          id="demo"
        >
          <div className="section-heading section-heading--split">
            <div>
              <p className="eyebrow">A voice agent, with receipts</p>
              <h2 id="demo-title">
                From one request to three authenticated actions.
              </h2>
            </div>
            <p>
              A deterministic restaurant call becomes an availability check, a
              reservation, and a confirmation—each visible in the trace.
            </p>
          </div>
          <TranscriptReplay />
          <p className="demo-caption">
            Transcript lines come from the repository’s restaurant voice demo.
            Flow labels clarify the user-facing sequence; canonical child tools
            remain visible beside them.{" "}
            <a className="text-link" href="/docs/capabilities/voice-agents">
              Read the full tutorial
              <ArrowIcon size={14} />
            </a>
          </p>
        </section>

        <section
          aria-labelledby="providers-title"
          className="section section--providers"
          id="providers"
        >
          <div className="section-heading section-heading--providers">
            <div>
              <p className="eyebrow">Catalog {CATALOG_STATS.catalogVersion}</p>
              <h2 id="providers-title">One surface, across the real stack.</h2>
              <p>
                Built manifests stay vivid. Roadmap providers stay visible, but
                deliberately quiet, until their executable contracts ship.
              </p>
            </div>
            <dl className="catalog-metrics">
              <div>
                <dt>Executable Manifests</dt>
                <dd>
                  {NUMBER_FORMATTER.format(CATALOG_STATS.implementedManifests)}
                </dd>
              </div>
              <div>
                <dt>Provider Roadmap</dt>
                <dd>
                  {NUMBER_FORMATTER.format(CATALOG_STATS.roadmapProviders)}
                </dd>
              </div>
              <div>
                <dt>Capabilities</dt>
                <dd>{NUMBER_FORMATTER.format(CATALOG_STATS.capabilities)}</dd>
              </div>
              <div>
                <dt>Canonical Contracts</dt>
                <dd>
                  {NUMBER_FORMATTER.format(CATALOG_STATS.canonicalContracts)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="provider-legend" role="note">
            <span>
              <span
                aria-hidden="true"
                className="legend-dot legend-dot--built"
              />
              Executable now
            </span>
            <span>
              <span
                aria-hidden="true"
                className="legend-dot legend-dot--catalog"
              />
              In catalog
            </span>
            <span className="provider-legend__note">
              {CATALOG_STATS.roadmapProviders} roadmap providers +{" "}
              {CATALOG_STATS.runtimeAdditions} native voice runtime ={" "}
              {CATALOG_STATS.implementedManifests} manifests
            </span>
          </div>

          <div className="provider-groups">
            {PROVIDER_GROUPS.map((group) => {
              const roadmapCount = group.providers.filter(
                ({ runtimeOnly }) => !runtimeOnly,
              ).length;
              const runtimeCount = group.providers.length - roadmapCount;
              return (
                <article
                  className={`provider-group provider-group--${group.id}`}
                  key={group.id}
                >
                  <header className="provider-group__header">
                    <div>
                      <h3>{group.label}</h3>
                      <p>{group.description}</p>
                    </div>
                    <span className="provider-group__count">
                      {NUMBER_FORMATTER.format(roadmapCount)}
                      {runtimeCount > 0 ? " + runtime" : ""}
                    </span>
                  </header>
                  <ul
                    aria-label={[group.label, "providers"].join(" ")}
                    className="provider-list"
                  >
                    {group.providers.map((provider) => (
                      <li
                        className={[
                          "provider-chip",
                          provider.implemented
                            ? "provider-chip--implemented"
                            : "provider-chip--catalog",
                          provider.runtimeOnly ? "provider-chip--runtime" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        key={provider.slug}
                      >
                        <span>{provider.displayName}</span>
                        <span className="provider-chip__state">
                          {provider.runtimeOnly
                            ? "built runtime"
                            : provider.implemented
                              ? "built"
                              : "in catalog"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>

        <section
          aria-labelledby="pillars-title"
          className="section section--pillars"
          id="why-eyeball"
        >
          <div className="section-heading section-heading--split">
            <div>
              <p className="eyebrow">
                The integration layer agents were missing
              </p>
              <h2 id="pillars-title">Small surface. Deep execution.</h2>
            </div>
            <p>
              Eyeball keeps the model-facing layer compact while owning the
              provider details that reliable execution depends on.
            </p>
          </div>
          <div className="pillar-grid">
            {PILLARS.map((pillar) => (
              <article className="pillar-card" key={pillar.number}>
                <span className="pillar-card__number">{pillar.number}</span>
                <h3>{pillar.title}</h3>
                <p>{pillar.copy}</p>
                <span className="pillar-card__signal">{pillar.signal}</span>
              </article>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="open-core-title"
          className="section section--open-core"
          id="open-core"
        >
          <div className="open-core-strip">
            <div className="open-core-strip__intro">
              <p className="eyebrow">Open Core</p>
              <h2 id="open-core-title">
                Open runtime. Managed connection layer.
              </h2>
              <p>
                The credential-provider seam is explicit, so the execution plane
                stays inspectable while hosted auth remains isolated.
              </p>
            </div>
            <div className="open-core-columns">
              <article>
                <span className="open-core-label">OSS Runtime</span>
                <h3>Run the tool plane yourself.</h3>
                <ul>
                  <li>Typed catalog and schemas</li>
                  <li>Executor, SDK, and MCP gateway</li>
                  <li>Local vault and deterministic mocks</li>
                </ul>
                <span
                  className="text-link text-link--disabled"
                  title="Public repository link coming soon"
                >
                  Source link coming soon
                  <ArrowIcon size={14} />
                </span>
              </article>
              <article>
                <span className="open-core-label open-core-label--cloud">
                  Eyeball Cloud · in development
                </span>
                <h3>Use the managed auth boundary.</h3>
                <ul>
                  <li>Hosted OAuth vault</li>
                  <li>Connect flows and token refresh</li>
                  <li>Billing and managed operations</li>
                </ul>
                <span className="open-core-note">Launch work in progress</span>
              </article>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
