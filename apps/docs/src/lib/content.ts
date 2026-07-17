import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  removeFencedCode,
  removeHtmlComments,
  slugifyHeading,
  stripInlineMarkdown,
} from "./markdown";

export interface NavigationGroup {
  group: string;
  pages: NavigationEntry[];
}

export type NavigationEntry = string | NavigationGroup;

export interface DocsConfig {
  name: string;
  description: string;
  colors: {
    primary: string;
  };
  appearance?: {
    default?: "dark" | "light";
  };
  navigation: NavigationGroup[];
}

export interface PageFrontmatter {
  title: string;
  description: string;
}

export interface DocPage {
  path: string;
  source: string;
  frontmatter: PageFrontmatter;
}

export interface PageHeading {
  id: string;
  title: string;
  level: 2 | 3;
}

export interface SearchRecord {
  path: string;
  title: string;
  headings: string[];
  excerpt: string;
}

export interface AdjacentPage {
  path: string;
  title: string;
}

function findRepositoryRoot(): string {
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, "docs-site", "docs.json"))) {
    return cwd;
  }

  return path.resolve(cwd, "../..");
}

const docsRoot = path.join(findRepositoryRoot(), "docs-site");
let configCache: DocsConfig | undefined;
let navigationPathsCache: string[] | undefined;
let sourcePathsCache: string[] | undefined;
let pageTitleMapCache: Record<string, string> | undefined;
let searchIndexCache: SearchRecord[] | undefined;
const pageCache = new Map<string, DocPage>();

function walkMdxFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMdxFiles(entryPath));
    } else if (entry.name.endsWith(".mdx")) {
      files.push(entryPath);
    }
  }

  return files;
}

function flattenEntries(entries: NavigationEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else {
      paths.push(...flattenEntries(entry.pages));
    }
  }
  return paths;
}

function assertFrontmatter(
  docPath: string,
  data: Record<string, unknown>,
): PageFrontmatter {
  if (typeof data.title !== "string" || typeof data.description !== "string") {
    throw new Error(
      `Documentation page ${docPath} must define string title and description frontmatter.`,
    );
  }

  return {
    title: data.title,
    description: data.description,
  };
}

export function getDocsConfig(): DocsConfig {
  if (!configCache) {
    configCache = JSON.parse(
      readFileSync(path.join(docsRoot, "docs.json"), "utf8"),
    ) as DocsConfig;
  }
  return configCache;
}

export function getNavigationPaths(): string[] {
  if (!navigationPathsCache) {
    navigationPathsCache = flattenEntries(getDocsConfig().navigation);
  }
  return navigationPathsCache;
}

export function getSourcePagePaths(): string[] {
  if (!sourcePathsCache) {
    sourcePathsCache = walkMdxFiles(docsRoot)
      .map((filePath) =>
        path
          .relative(docsRoot, filePath)
          .replaceAll(path.sep, "/")
          .replace(/\.mdx$/, ""),
      )
      .sort();
  }
  return sourcePathsCache;
}

export function getDocPage(docPath: string): DocPage | undefined {
  const cached = pageCache.get(docPath);
  if (cached) {
    return cached;
  }

  if (!getSourcePagePaths().includes(docPath)) {
    return undefined;
  }

  const filePath = path.join(docsRoot, `${docPath}.mdx`);
  const parsed = matter(readFileSync(filePath, "utf8"));
  const page: DocPage = {
    path: docPath,
    source: removeHtmlComments(parsed.content),
    frontmatter: assertFrontmatter(docPath, parsed.data),
  };
  pageCache.set(docPath, page);
  return page;
}

export function pathToHref(docPath: string): string {
  return docPath === "index" ? "/" : `/${docPath}`;
}

export function routeSegmentsToPath(segments?: string[]): string {
  return segments && segments.length > 0 ? segments.join("/") : "index";
}

export function getPageHeadings(source: string): PageHeading[] {
  const headings: PageHeading[] = [];
  const markdown = removeFencedCode(removeHtmlComments(source));

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const title = stripInlineMarkdown(match[2]);
    headings.push({
      id: slugifyHeading(title),
      title,
      level: match[1].length as 2 | 3,
    });
  }

  return headings;
}

function getFirstParagraph(source: string): string {
  const markdown = removeFencedCode(removeHtmlComments(source));
  const blocks = markdown.split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const value = block.trim();
    if (!value || /^(#|<|>|\||-|\*|\d+\.|import\s|export\s)/.test(value)) {
      continue;
    }

    const paragraph = stripInlineMarkdown(value);
    if (paragraph) {
      return paragraph.length > 240
        ? `${paragraph.slice(0, 237).trimEnd()}…`
        : paragraph;
    }
  }

  return "";
}

export function getPageTitleMap(): Record<string, string> {
  if (!pageTitleMapCache) {
    pageTitleMapCache = Object.fromEntries(
      getSourcePagePaths().map((docPath) => {
        const page = getDocPage(docPath);
        if (!page) {
          throw new Error(`Missing documentation page ${docPath}.`);
        }
        return [docPath, page.frontmatter.title];
      }),
    );
  }
  return pageTitleMapCache;
}

export function getSearchIndex(): SearchRecord[] {
  if (!searchIndexCache) {
    searchIndexCache = getNavigationPaths().map((docPath) => {
      const page = getDocPage(docPath);
      if (!page) {
        throw new Error(`Navigation references missing page ${docPath}.`);
      }

      return {
        path: pathToHref(docPath),
        title: page.frontmatter.title,
        headings: getPageHeadings(page.source).map((heading) => heading.title),
        excerpt: getFirstParagraph(page.source),
      };
    });
  }
  return searchIndexCache;
}

export function getAdjacentPages(docPath: string): {
  previous?: AdjacentPage;
  next?: AdjacentPage;
} {
  const paths = getNavigationPaths();
  const index = paths.indexOf(docPath);
  const titles = getPageTitleMap();
  const previousPath = index > 0 ? paths[index - 1] : undefined;
  const nextPath = index >= 0 ? paths[index + 1] : undefined;
  const result: { previous?: AdjacentPage; next?: AdjacentPage } = {};

  if (previousPath) {
    result.previous = {
      path: pathToHref(previousPath),
      title: titles[previousPath] ?? previousPath,
    };
  }
  if (nextPath) {
    result.next = {
      path: pathToHref(nextPath),
      title: titles[nextPath] ?? nextPath,
    };
  }

  return result;
}
