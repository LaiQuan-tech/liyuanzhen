import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // tsconfig 是 jsx: "preserve"（給 Next 用），vite 照 tsconfig 就不轉 JSX，.tsx 在測試裡解析不了。
  // components/avatar/AvatarStage.harness.test.ts 要載入真的 AvatarStage.tsx，所以這裡明講用 automatic runtime
  // （測試環境產生的是 react/jsx-dev-runtime 的 jsxDEV，那支治具把它換成假的）。只影響 .tsx，.ts 不受影響。
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
