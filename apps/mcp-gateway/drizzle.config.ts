import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/stores/postgres/schema.ts",
  out: "./migrations",
});
