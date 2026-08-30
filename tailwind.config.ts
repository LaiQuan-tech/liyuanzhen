import type { Config } from "tailwindcss";

/**
 * ⚠️ 色票是**雙軌**的：這裡與 app/globals.css 的 :root 各寫一份，
 * 兩邊的值必須一致。只改一邊等於沒改。
 *
 * 色值取樣自《我來了！臺灣婦女改變了》書封原檔。完整說明與對比度實測
 * 寫在 globals.css 的檔頭（那份是主要文件）。
 * 簡述：書封是單一色相的濃淡階梯，所以分區靠深淺不靠色相，全部實測 ≥ 4.5:1。
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
        // 書封背景色，原樣。ink 在它上面 12.03:1
        paper: { DEFAULT: "#DBD3EA", alt: "#FFFFFF", tint: "#D2CAE6" },
        // ⚠️ soft 從 #2E2A1C（暖褐黑）改成冷調——暖黑在薰衣草底上會發濁
        ink: { DEFAULT: "#1A1A1A", pure: "#000000", soft: "#2C2635" },
        // ⚠️ 這兩個在 paper-tint 上最吃緊。#5C5570 只有 4.14:1、#625B78 只有 3.77:1，
        // 都不及格；現在的值最差 5.07 / 4.77。light 寫的是 ANSWER_DISCLAIMER，
        // 那是法律上必須存在的字——看不清楚等於沒有。改色一定要重算。
        muted: { DEFAULT: "#544D66", light: "#585070" },
        // 🔴 brand ＝ 書名毛筆的紫，是**深色**。舊版的黃是淺色配 ink，
        // 換過來之後 bg-brand 上的字一律要 text-white，不要沿用 text-ink。
        // soft 是給「深底上的淺字」用的（配 ink 底 9.29:1），不要拿它當背景。
        brand: { DEFAULT: "#63518D", soft: "#C3B7E4", wash: "#EDE9F6" },

        // 五色分區＝書封的濃淡階梯，不是五個色相。
        // 註記的是「這個色當背景時，其上的文字該用什麼顏色」——不要用反。
        wine: { DEFAULT: "#5D1D3D", wash: "#F1E8ED" }, //  配 white 12.29:1  Hero
        plum: { DEFAULT: "#593B56", wash: "#F0EBEF" }, //  配 white  9.61:1
        violet: { DEFAULT: "#63518D", wash: "#EDE9F6" }, // 配 white  6.79:1
        dusk: { DEFAULT: "#716A90", wash: "#EBEAF3" }, //  配 white  5.04:1
        mist: { DEFAULT: "#B7B7D4", wash: "#F0F0F7" }, //  配 ink    8.90:1

        ok: "#15803D",
        hairline: "rgba(45,32,58,.14)",
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
