// Correctness only, because formatting is Prettier's job at Prettier's own defaults.
import js from "@eslint/js";
import globals from "globals";

export default [
  // Read-only copies (see each file's header): a copy is never changed here, so this project's lint rules must not judge it; only its canonical version changes.
  { ignores: ["scripts/secrets-scan.mjs", "scripts/license-check.mjs"] },
  // node_modules is ignored by ESLint itself by default; only dist needs stating.
  { ignores: ["dist/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { sourceType: "module" },
    rules: {
      // The shipped CSP grants no 'unsafe-eval', so an eval that reaches the page is a page that doesn't run.
      "no-eval": "error",
      "no-implied-eval": "error",
      // Storage, media teardown and mediaSession are all best-effort: `catch {}` there is intended, not an unfinished block.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  // Each scope is granted exactly the globals its own runtime provides — lumping all three into one set would stop no-undef catching anything.
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["*.mjs", "scripts/**", "tests/**", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Playwright evaluates these inside a real page but ESLint reads them lexically, so without browser globals it's a wall of no-undef.
    files: ["tests/e2e.test.mjs", "tests/sw-update.test.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
