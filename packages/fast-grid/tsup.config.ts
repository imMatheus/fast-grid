// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"], // Output both ESM and CommonJS formats
  clean: true, // Clean the dist folder before building
  dts: true, // Generate TypeScript declaration files
});
