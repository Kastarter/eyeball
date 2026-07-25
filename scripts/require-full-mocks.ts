import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fullMockhouseEntry = fileURLToPath(
  new URL("../mocks/apps/mockhouse/src/index.ts", import.meta.url),
);

if (!existsSync(fullMockhouseEntry)) {
  process.stderr.write("requires the full mocks checkout\n");
  process.exitCode = 1;
}
