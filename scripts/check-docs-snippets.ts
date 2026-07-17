import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { defaultCatalog } from "../packages/catalog/src/default.js";
import { type JsonValue, validateInput } from "../packages/core/src/index.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = join(repositoryRoot, "docs-site");
const nonStatic = Symbol("non-static");

function propertyName(node: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function staticJson(node: ts.Expression): JsonValue | typeof nonStatic {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return staticJson(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: JsonValue[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        return nonStatic;
      }
      const value = staticJson(element);
      if (value === nonStatic) {
        return nonStatic;
      }
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, JsonValue> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return nonStatic;
      }
      const name = propertyName(property.name);
      const propertyValue = staticJson(property.initializer);
      if (name === undefined || propertyValue === nonStatic) {
        return nonStatic;
      }
      value[name] = propertyValue;
    }
    return value;
  }
  return nonStatic;
}

function objectProperty(
  node: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function validateStaticToolInputs(code: string, path: string): string[] {
  const errors: string[] = [];
  const source = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "run" ||
        node.expression.name.text === "execute") &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "tools"
    ) {
      const [toolNode, requestNode] = node.arguments;
      if (
        toolNode !== undefined &&
        ts.isStringLiteral(toolNode) &&
        requestNode !== undefined
      ) {
        const inputNode =
          node.expression.name.text === "run"
            ? requestNode
            : ts.isObjectLiteralExpression(requestNode)
              ? objectProperty(requestNode, "input")
              : undefined;
        if (inputNode !== undefined) {
          const input = staticJson(inputNode);
          if (input !== nonStatic) {
            const tool = defaultCatalog.getTool(toolNode.text);
            const line =
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1;
            if (tool === undefined) {
              errors.push(`${path}:${line}: unknown tool ${toolNode.text}`);
            } else {
              const result = validateInput(tool, input);
              if (!result.ok) {
                errors.push(
                  `${path}:${line}: ${toolNode.text} input fails its canonical schema: ${JSON.stringify(result.errors)}`,
                );
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

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

const frameworkShims = `
declare module "@anthropic-ai/sdk" {
  namespace Anthropic {
    interface MessageParam { role: "user" | "assistant"; content: string | readonly unknown[] }
    interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
    interface Message {
      content: Array<ToolUseBlock | { type: string; text?: string }>;
      stop_reason: string | null;
    }
  }
  class Anthropic {
    messages: {
      create(input: {
        model: string;
        max_tokens: number;
        messages: Anthropic.MessageParam[];
        tools: readonly unknown[];
      }): Promise<Anthropic.Message>;
    };
  }
  export default Anthropic;
}

declare module "openai" {
  namespace OpenAI {
    namespace Chat.Completions {
      interface ChatCompletionMessageParam { role: string; content?: unknown; tool_calls?: unknown[] }
      interface ChatCompletionMessage {
        role: "assistant";
        content: string | null;
        tool_calls?: Array<{
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }>;
      }
    }
  }
  class OpenAI {
    chat: {
      completions: {
        create(input: {
          model: string;
          messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
          tools: readonly unknown[];
        }): Promise<{ choices: Array<{ message: OpenAI.Chat.Completions.ChatCompletionMessage }> }>;
      };
    };
  }
  export default OpenAI;
}

declare module "ai" {
  export function generateText(input: {
    model: unknown;
    prompt: string;
    tools: Record<string, unknown>;
    maxSteps?: number;
  }): Promise<{ text: string }>;
}

declare module "@ai-sdk/anthropic" {
  export function anthropic(model: string): unknown;
}
`;

async function main(): Promise<void> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "eyeball-docs-snippets-"));
  try {
    const shimsPath = join(tempDirectory, "framework-shims.d.ts");
    await writeFile(shimsPath, frameworkShims, "utf8");
    const snippetPaths: string[] = [shimsPath];
    let snippetCount = 0;
    const schemaErrors: string[] = [];

    for (const path of await walk(docsRoot)) {
      if (!path.endsWith(".mdx")) {
        continue;
      }
      const source = await readFile(path, "utf8");
      const expression =
        /(?:^|\n)\x60{3}(?:ts|typescript)\s*\n(?<code>[\s\S]*?)\n\x60{3}/gu;
      let index = 0;
      for (const match of source.matchAll(expression)) {
        const code = match.groups?.code;
        if (code === undefined) {
          continue;
        }
        const snippetPath = join(
          tempDirectory,
          `${basename(path, ".mdx")}-${snippetCount}-${index}.ts`,
        );
        await writeFile(
          snippetPath,
          `// Extracted from ${relative(repositoryRoot, path)}\n${code}\n`,
          "utf8",
        );
        schemaErrors.push(
          ...validateStaticToolInputs(
            code,
            `${relative(repositoryRoot, path)}#snippet-${index + 1}`,
          ),
        );
        snippetPaths.push(snippetPath);
        snippetCount += 1;
        index += 1;
      }
    }

    if (snippetCount === 0) {
      throw new Error("No TypeScript snippets were found.");
    }
    if (schemaErrors.length > 0) {
      throw new Error(
        `Static documentation inputs failed schema validation:\n- ${schemaErrors.join("\n- ")}`,
      );
    }

    const program = ts.createProgram(snippetPaths, {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      baseUrl: repositoryRoot,
      paths: {
        "@eyeball/catalog": ["packages/catalog/dist/index.d.ts"],
        "@eyeball/core": ["packages/core/dist/index.d.ts"],
        "@eyeball/sdk": ["packages/sdk/src/index.ts"],
      },
      types: ["node"],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => repositoryRoot,
          getNewLine: () => "\n",
        }),
      );
    }
    console.log(
      `Type-checked ${snippetCount} extracted TypeScript snippets and validated their static tool inputs.`,
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
