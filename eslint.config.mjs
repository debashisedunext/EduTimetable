import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
  },
  /**
   * Rules of Hooks, on the web app only.
   *
   * Added after §27 shipped a real violation past every other gate: an early
   * `return` sat above a `useMemo` and a `useEffect`, so the render that added
   * a school's first wing ran more hooks than the one before it. Typecheck,
   * unit tests and the smoke suite all passed — nothing but this rule looks at
   * hook ORDER, and the crash only appears in a browser on the one path every
   * new school takes.
   *
   * `rules-of-hooks` only. `exhaustive-deps` is deliberately left off: several
   * screens key a `useMemo` on `JSON.stringify([...])` to compare draft answers
   * by value, and that rule cannot see through it — it would report a wall of
   * false positives and teach everybody to ignore the plugin.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
);
