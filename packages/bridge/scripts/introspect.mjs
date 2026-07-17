import { generateIntrospectionReport, spikePieces } from "../dist/index.js";

process.stdout.write(
  `${JSON.stringify(generateIntrospectionReport(spikePieces), null, 2)}\n`,
);
