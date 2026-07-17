const TOOLKIT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function parseContractProviderFilter(
  value: string | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const providers = value
    .split(",")
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);
  if (providers.length === 0) {
    throw new Error(
      "EYEBALL_CONTRACT_PROVIDERS must contain at least one provider slug when set.",
    );
  }
  const invalid = providers.filter(
    (provider) => !TOOLKIT_SLUG_PATTERN.test(provider),
  );
  if (invalid.length > 0) {
    throw new Error(
      `EYEBALL_CONTRACT_PROVIDERS contains invalid slug(s): ${invalid.join(", ")}.`,
    );
  }
  if (new Set(providers).size !== providers.length) {
    throw new Error("EYEBALL_CONTRACT_PROVIDERS must not contain duplicates.");
  }
  return new Set(providers);
}

export function validateContractProviderFilter(
  filter: ReadonlySet<string> | undefined,
  knownProviders: readonly string[],
): void {
  if (filter === undefined) {
    return;
  }
  const known = new Set(knownProviders);
  const unknown = [...filter].filter((provider) => !known.has(provider));
  if (unknown.length > 0) {
    throw new Error(
      `EYEBALL_CONTRACT_PROVIDERS contains unknown provider(s): ${unknown.join(", ")}.`,
    );
  }
}
