import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "node_modules/**", "services/**", "vendor/**", "tests/**"]),
  // Pre-existing patterns in the login/dashboard components; tracked as warnings until refactored.
  { rules: { "react-hooks/purity": "warn", "react-hooks/set-state-in-effect": "warn" } },
]);
