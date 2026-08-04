import type { Config } from "tailwindcss";

/**
 * 色票與字體直接對應提案簡報 liyuanzhen-pitch/index.html 的 :root 變數，
 * 讓網站與 deck 是同一套視覺語言。改這裡等於改設計系統。
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./content/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: "#FFFBEC", alt: "#FFFFFF", tint: "#FFF6D6" },
        ink: { DEFAULT: "#1A1A1A", pure: "#000000", soft: "#2E2A1C" },
        muted: { DEFAULT: "#6B6357", light: "#9C9384" },
        brand: { DEFAULT: "#FFCE00", soft: "#FFE680", wash: "#FFF6D6" },
        ok: "#15803D",
        hairline: "rgba(26,26,26,.11)",
      },
      fontFamily: {
        display: ["var(--font-baloo)", "var(--font-noto)", "sans-serif"],
        sans: ["var(--font-noto)", "sans-serif"],
      },
      boxShadow: {
        // deck 的招牌硬偏移陰影：零模糊、深墨低透明度，隨元件份量放大
        sticker: "3px 4px 0 rgba(26,26,26,.12)",
        "sticker-md": "4px 5px 0 rgba(26,26,26,.12)",
        "sticker-lg": "5px 6px 0 rgba(26,26,26,.18)",
        "sticker-xl": "8px 10px 0 rgba(26,26,26,.14)",
        cta: "3px 4px 0 rgba(26,26,26,.18)",
        "cta-hover": "5px 7px 0 rgba(26,26,26,.22)",
      },
      transitionTimingFunction: {
        deck: "cubic-bezier(.16,1,.3,1)",
      },
    },
  },
  plugins: [],
};

export default config;
