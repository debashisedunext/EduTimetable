import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // scripts/ holds standalone Node/shell tools run inside the containers
  // (smoke tests, benchmarks) — not part of the app's module graph.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.html",
      "scripts/**",
      // Prisma emits the control-plane client here (§17.3); generated code is
      // not ours to lint and is git-ignored.
      "apps/api/prisma/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
