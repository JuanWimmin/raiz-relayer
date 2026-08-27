import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Los tests de integración contra testnet solo corren con RELAYER_IT=1
    exclude: process.env.RELAYER_IT === "1" ? [] : ["test/integration/**"],
    testTimeout: process.env.RELAYER_IT === "1" ? 180_000 : 10_000,
    environment: "node",
  },
});
