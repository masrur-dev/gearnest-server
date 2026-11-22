import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      ".vercel/**",
      "coverage/**",
      ".opencode/**",
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly",
        AbortSignal: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
      },
    },

    rules: {
      // Express error handlers need four declared arguments;
      // route callbacks often ignore one of them.
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^(next|_)",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
