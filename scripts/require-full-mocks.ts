import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fullMocksRoot = fileURLToPath(new URL("../mocks/", import.meta.url));
const fullMockhouseEntry = resolve(
  fullMocksRoot,
  "apps/mockhouse/src/index.ts",
);

if (!existsSync(fullMockhouseEntry)) {
  process.stderr.write("requires the full mocks checkout\n");
  process.exitCode = 1;
} else {
  const target = process.argv[2];
  if (target !== undefined) {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(process.cwd(), target)],
      {
        env: { ...process.env, EYEBALL_FULL_MOCKS_ROOT: fullMocksRoot },
        stdio: "inherit",
      },
    );
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}
