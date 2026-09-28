// The lint every module here is held to: the recommended sets, the function
// length cap and strict equality. No rule in it is type-aware, because no
// module here is TypeScript and there is no program for one to ask.
//
// A function is at most 70 lines, blank and comment lines excluded. The count
// is the linter's, so the rule cannot drift from what is measured.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.claude/` is the agent harness's, and its worktrees are whole checkouts
  // of this repository; `.chug/` and `.githooks/` are shell.
  { ignores: ["node_modules/**", ".chug/**", ".githooks/**", ".claude/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly" } },
    rules: {
      "max-lines-per-function": [
        "error",
        { max: 70, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      eqeqeq: ["error", "always"],
    },
  },
  // `.dependency-cruiser.cjs`, which the tool loads as CommonJS.
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable" },
    },
  },
);
