/**
 * 「這一頁只有管理員看得到」。
 *
 * 🔴 這個畫面不是守門，`requireManager()` 才是。它只是讓小編撞到的時候
 * 看到一句話，而不是一個 500 白畫面。
 *
 * ⚠️ 訊息要跟「此帳號沒有後台權限」分開。對一個小編說「你沒有後台權限」
 * 是錯的——他明明就在後台裡，只是這一頁不歸他管，而正確的下一步也不同
 *（前者是「請管理員把你加進後台人員」，這裡是「請管理員處理」）。
 *
 * ⚠️ 刻意**不**用 notFound()。假裝這一頁不存在會讓小編以為是連結壞了，
 * 然後去問工程師。講清楚「有這一頁，但不歸你管」比較省事。
 */
export default function ManagerOnlyNotice({ what }: { what: string }) {
  return (
    <div className="max-w-xl">
      <h1 className="font-display text-[20px] font-extrabold">這一頁只有管理員看得到</h1>
      <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
        {what}屬於管理員的權限。你的帳號是<strong>小編</strong>，
        可以上架場次、看報名名單與問答紀錄。
      </p>
      <p className="mt-3 text-[13.5px] text-muted">需要用到這一頁的話，請找管理員。</p>
    </div>
  );
}
