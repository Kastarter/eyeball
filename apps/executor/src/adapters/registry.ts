import { EyeballError, TOOL_ERROR_CODES } from "@eyeball/core";
import type { ToolkitAdapter } from "./types.js";

export class AdapterRegistry {
  readonly #adapters = new Map<string, ToolkitAdapter>();

  constructor(adapters: readonly ToolkitAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ToolkitAdapter): this {
    if (adapter.toolkitSlug.trim().length === 0) {
      throw new Error("Adapter toolkit slug must not be empty.");
    }
    if (this.#adapters.has(adapter.toolkitSlug)) {
      throw new Error(`Duplicate toolkit adapter: ${adapter.toolkitSlug}`);
    }
    this.#adapters.set(adapter.toolkitSlug, adapter);
    return this;
  }

  get(toolkitSlug: string): ToolkitAdapter | undefined {
    return this.#adapters.get(toolkitSlug);
  }

  require(toolkitSlug: string): ToolkitAdapter {
    const adapter = this.get(toolkitSlug);
    if (adapter === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `Toolkit ${toolkitSlug} is not supported by this executor.`,
      });
    }
    return adapter;
  }

  listToolkitSlugs(): readonly string[] {
    return [...this.#adapters.keys()].sort();
  }
}
