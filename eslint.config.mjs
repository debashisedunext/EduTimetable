import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // scripts/ holds standalone Node/shell tools run inside the containers
  // (smoke tests, benchmarks) — not part of the app's module graph.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.html", "scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
