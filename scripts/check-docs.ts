import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface NavigationGroup {
  group: string;
  pages: (string | NavigationGroup)[];
}

interface DocsConfig {
  navigation: NavigationGroup[];
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = join(repositoryRoot, "docs-site");
const errors: string[] = [];

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return children.flat().sort();
}

function navPages(groups: readonly NavigationGroup[]): string[] {
  return groups.flatMap((group) =>
    group.pages.flatMap((page) =>
      typeof page === "string" ? [page] : navPages([page]),
    ),
  );
}

function checkFrontmatter(path: string, source: string): void {
  if (!source.startsWith("---\n")) {
    errors.push(`${path}: frontmatter must be the first block`);
    return;
  }
  const close = source.indexOf("\n---\n", 4);
  if (close === -1) {
    errors.push(`${path}: frontmatter is not closed`);
    return;
  }
  const frontmatter = source.slice(4, close);
  for (const field of ["title", "description"]) {
    if (!new RegExp(`^${field}:\\s*.+$`, "mu").test(frontmatter)) {
      errors.push(`${path}: frontmatter is missing ${field}`);
    }
  }
}

function checkFences(path: string, source: string): void {
  let open: { line: number; marker: string } | undefined;
  for (const [index, line] of source.split("\n").entries()) {
    const match = /^(?<marker>\x60{3,}|~{3,})/.exec(line);
    if (match?.groups?.marker === undefined) {
      continue;
    }
    const marker = match.groups.marker;
    if (open === undefined) {
      open = { line: index + 1, marker };
    } else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length
    ) {
      open = undefined;
    }
  }
  if (open !== undefined) {
    errors.push(`${path}:${open.line}: unclosed code fence`);
  }
}

function checkInternalLinks(
  path: string,
  source: string,
  pageSet: ReadonlySet<string>,
): void {
  const markdownLinks = source.matchAll(/\]\(\/(?<target>[^)\s]+)\)/gu);
  const componentLinks = source.matchAll(
    /\bhref=["']\/(?<target>[^"']+)["']/gu,
  );
  for (const match of [...markdownLinks, ...componentLinks]) {
    const target = match.groups?.target
      ?.split("#", 1)[0]
      ?.split("?", 1)[0]
      ?.replace(/\.mdx$/u, "");
    if (target !== undefined && target !== "" && !pageSet.has(target)) {
      errors.push(`${path}: internal link /${target} has no page`);
    }
  }
}

async function main(): Promise<void> {
  const docsPath = join(docsRoot, "docs.json");
  const docs = JSON.parse(await readFile(docsPath, "utf8")) as DocsConfig;
  const configuredPages = navPages(docs.navigation);
  const pageSet = new Set(configuredPages);
  if (configuredPages.length !== pageSet.size) {
    errors.push("docs.json contains duplicate navigation paths");
  }

  const files = await walk(docsRoot);
  const mdxFiles = files.filter((path) => extname(path) === ".mdx");
  const diskPages = new Set(
    mdxFiles.map((path) =>
      relative(docsRoot, path)
        .split(sep)
        .join("/")
        .replace(/\.mdx$/u, ""),
    ),
  );

  for (const page of configuredPages) {
    if (!diskPages.has(page)) {
      errors.push(`docs.json references missing page: ${page}.mdx`);
    }
  }
  for (const page of diskPages) {
    if (!pageSet.has(page)) {
      errors.push(`MDX page is not in docs.json navigation: ${page}.mdx`);
    }
  }

  for (const path of mdxFiles) {
    const source = await readFile(path, "utf8");
    const displayPath = relative(repositoryRoot, path);
    checkFrontmatter(displayPath, source);
    checkFences(displayPath, source);
    checkInternalLinks(displayPath, source, pageSet);
  }

  const generatedToolkits = mdxFiles.filter((path) =>
    path.startsWith(join(docsRoot, "toolkits", "generated") + sep),
  );
  if (generatedToolkits.length !== 37) {
    errors.push(
      `expected 37 generated toolkit pages, found ${generatedToolkits.length}`,
    );
  }
  const generatedSdk = mdxFiles.filter((path) =>
    path.startsWith(join(docsRoot, "sdk", "generated") + sep),
  );
  if (generatedSdk.length !== 9) {
    errors.push(`expected 9 generated SDK pages, found ${generatedSdk.length}`);
  }
  for (const path of [...generatedToolkits, ...generatedSdk]) {
    const source = await readFile(path, "utf8");
    if (!source.includes("DO NOT EDIT")) {
      errors.push(
        `${relative(repositoryRoot, path)}: missing DO NOT EDIT header`,
      );
    }
  }

  const errorPage = await readFile(
    join(docsRoot, "concepts", "errors.mdx"),
    "utf8",
  );
  for (const code of [
    "invalid_input",
    "auth_missing",
    "auth_expired",
    "auth_insufficient_scope",
    "not_found",
    "rate_limited",
    "provider_unavailable",
    "provider_error",
    "timeout",
    "not_supported",
  ]) {
    if (!errorPage.includes(`id="${code}"`)) {
      errors.push(`concepts/errors.mdx is missing the ${code} anchor`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Documentation validation failed:\n- ${errors.join("\n- ")}`,
    );
  }
  console.log(
    `Validated ${mdxFiles.length} MDX pages (${generatedToolkits.length + generatedSdk.length} generated) and ${configuredPages.length} navigation entries.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
