import rehypeShiki from "@shikijs/rehype";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { Icon } from "@/src/components/icon";
import { mdxComponents } from "@/src/components/mdx-components";
import { OnThisPage } from "@/src/components/on-this-page";
import { PageFeedback } from "@/src/components/page-feedback";
import {
  type AdjacentPage,
  type DocsConfig,
  getAdjacentPages,
  getDocPage,
  getDocsConfig,
  getNavigationPaths,
  getPageHeadings,
  type NavigationEntry,
  routeSegmentsToPath,
} from "@/src/lib/content";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export const dynamic = "force-static";
export const dynamicParams = false;

function findNavigationTrail(
  entries: NavigationEntry[],
  currentPath: string,
): string[] | undefined {
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry === currentPath) {
        return [];
      }
      continue;
    }

    const nested = findNavigationTrail(entry.pages, currentPath);
    if (nested) {
      return [entry.group, ...nested];
    }
  }

  return undefined;
}

function getNavigationTrail(config: DocsConfig, currentPath: string): string[] {
  for (const group of config.navigation) {
    const nested = findNavigationTrail(group.pages, currentPath);
    if (nested) {
      return [group.group, ...nested];
    }
  }

  return [];
}

function AdjacentLink({
  direction,
  page,
}: {
  direction: "next" | "previous";
  page: AdjacentPage;
}) {
  return (
    <Link
      className={`page-nav-link page-nav-link--${direction}`}
      href={page.path}
    >
      {direction === "previous" ? <Icon name="chevron-left" size={17} /> : null}
      <span>
        <small>{direction === "previous" ? "Previous" : "Next"}</small>
        <strong>{page.title}</strong>
      </span>
      {direction === "next" ? <Icon name="chevron-right" size={17} /> : null}
    </Link>
  );
}

export function generateStaticParams() {
  return getNavigationPaths().map((path) => ({
    slug: path === "index" ? [] : path.split("/"),
  }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocPage(routeSegmentsToPath(slug));
  if (!page) {
    return {};
  }

  return {
    title: page.frontmatter.title,
    description: page.frontmatter.description,
  };
}

export default async function DocumentationPage({ params }: PageProps) {
  const { slug } = await params;
  const currentPath = routeSegmentsToPath(slug);
  const page = getDocPage(currentPath);
  if (!page) {
    notFound();
  }

  const { content } = await compileMDX({
    source: page.source,
    components: mdxComponents,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          [
            rehypeShiki,
            {
              addLanguageClass: true,
              defaultColor: false,
              defaultLanguage: "text",
              fallbackLanguage: "text",
              langAlias: {
                js: "javascript",
                sh: "bash",
                ts: "typescript",
              },
              langs: ["bash", "http", "javascript", "json", "typescript"],
              lazy: false,
              themes: {
                dark: "github-dark",
                light: "github-light",
              },
            },
          ],
        ],
      },
    },
  });
  const adjacent = getAdjacentPages(currentPath);
  const navigationTrail = getNavigationTrail(getDocsConfig(), currentPath);
  const eyebrow = navigationTrail.at(-1) ?? "Documentation";
  const breadcrumbTrail = navigationTrail.slice(0, -1);
  const headings = getPageHeadings(page.source);
  const sourceHref = `https://github.com/eyeball-ai/eyeball/blob/main/docs-site/${currentPath}.mdx`;

  return (
    <>
      <main className="docs-main" id="main-content">
        <article>
          <header className="page-header">
            <nav aria-label="Breadcrumb" className="page-breadcrumb">
              <Link href="/">Documentation</Link>
              {breadcrumbTrail.map((item) => (
                <span className="page-breadcrumb__item" key={item}>
                  <Icon name="chevron-right" size={11} />
                  <span>{item}</span>
                </span>
              ))}
            </nav>
            <div className="page-header__eyebrow">{eyebrow}</div>
            <h1>{page.frontmatter.title}</h1>
            <p>{page.frontmatter.description}</p>
          </header>
          <div className="prose">{content}</div>
          <footer className="page-footer">
            <PageFeedback />
            <div className="page-footer__links">
              {adjacent.previous ? (
                <AdjacentLink direction="previous" page={adjacent.previous} />
              ) : (
                <span />
              )}
              {adjacent.next ? (
                <AdjacentLink direction="next" page={adjacent.next} />
              ) : (
                <span />
              )}
            </div>
            <div className="page-footer__meta">
              <span>Built from the repository’s authored MDX.</span>
              <a href={sourceHref} rel="noreferrer" target="_blank">
                View source <Icon name="chevron-right" size={13} />
              </a>
            </div>
          </footer>
        </article>
      </main>

      <aside className="docs-toc">
        <OnThisPage headings={headings} />
      </aside>
    </>
  );
}
