import type { Config } from "tailwindcss";

/**
 * ⚠️ 色票是**雙軌**的：這裡與 app/globals.css 的 :root 各寫一份，
 * 兩邊的值必須一致。只改一邊等於沒改。
 *
 * 每個顏色的對比度與用途說明寫在 globals.css 的檔頭（那份是主要文件）。
 * 簡述：五色分區，每個首頁區塊輪一個主色，全部實測過 ≥ 4.5:1。
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
        // ⚠️ light 從 #9C9384 改成 #726B5F。舊值在白底上只有 3.03:1，
        // 而它被拿來寫 ANSWER_DISCLAIMER（法律／倫理上必須存在的免責句）
        // 與時間軸的補充說明——**必須存在的字看不清楚，等於沒有**。
        // 新值在白、紙、以及五個 wash 底色上最差 4.54:1，全部通過。
        // 這是實測抓到的，不是看出來的：光看設計稿不會發現。
        muted: { DEFAULT: "#6B6357", light: "#726B5F" },
        brand: { DEFAULT: "#FFCE00", soft: "#FFE680", wash: "#FFF6D6" },

        // 五色分區。每組的 wash 是同色系的極淺底，給卡片與次要區塊用。
        // 註記的是「這個色當背景時，其上的文字該用什麼顏色」——不要用反。
        flame: { DEFAULT: "#FF6B35", wash: "#FFF0EA" }, // 配 ink   6.14:1
        rose: { DEFAULT: "#C4126B", wash: "#FDEAF3" }, //  配 white 5.76:1
        violet: { DEFAULT: "#5B2D8E", wash: "#F1ECF8" }, // 配 white 9.50:1
        teal: { DEFAULT: "#0F7A6B", wash: "#E7F4F1" }, //  配 white 5.23:1

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
