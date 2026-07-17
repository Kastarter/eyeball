import rehypeShiki from "@shikijs/rehype";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { DocsShell } from "@/src/components/docs-shell";
import { mdxComponents } from "@/src/components/mdx-components";
import {
  getAdjacentPages,
  getDocPage,
  getDocsConfig,
  getNavigationPaths,
  getPageHeadings,
  getPageTitleMap,
  getSearchIndex,
  routeSegmentsToPath,
} from "@/src/lib/content";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export const dynamic = "force-static";
export const dynamicParams = false;

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

  return (
    <DocsShell
      config={getDocsConfig()}
      currentPath={currentPath}
      description={page.frontmatter.description}
      headings={getPageHeadings(page.source)}
      next={adjacent.next}
      previous={adjacent.previous}
      searchIndex={getSearchIndex()}
      title={page.frontmatter.title}
      titles={getPageTitleMap()}
    >
      {content}
    </DocsShell>
  );
}
