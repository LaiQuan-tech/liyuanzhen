#!/usr/bin/env python3
"""
從一張 Q 版立繪產出 public/chibi/ 的五個素材（底圖 ＋ 四個嘴型）。

    python3 scripts/build-chibi-assets.py <來源圖.jpeg|png>

## 為什麼是腳本而不是「當初手動處理一次」

正式美術素材進來時同一套要再跑一次。下面每一個常數都是量出來的，
不是試出來的——重來一次沒有這份記錄就要再迭代四輪。

## 三個踩過的坑（改參數前先讀）

🔴 **flood fill 要跟固定的背景參考色比，不要跟鄰居比。**
   跟鄰居比的話，抗鋸齒的漸層會變成一條讓 fill 走進人物內部的通道。
   第一次就是這樣，人物只剩 21,916 px（正確值 164,974）。

🔴 **不可以用「亮度門檻」去背。** 球鞋是白的，跟背景只差 1–2 階
   （兩腿之間 254,249,245／鞋白 254,250,247）。顏色分不出來，
   只能靠連通塊的位置：腿間與影子是同一塊、跨滿人物寬度；
   鞋白是兩小塊、左右對稱、被鞋子的深色輪廓包住。

⚠️ **嘴型曲線要從原圖萃取，不要憑感覺畫。** 第一版憑感覺的結果是
   位置偏高、末端平切、弧度太淺。萃取出來的是二次曲線，殘差 0.89px，
   而且最低點不在正中（人物的頭是微側的）。
"""
import sys, json, os
from collections import deque
import numpy as np
from PIL import Image, ImageDraw

OUT = "public/chibi"
# 這幾個是針對第一版立繪量出來的。換圖務必重量（腳本會印出實際值）。
SHIRT_TEXT_ROWS = (460, 510)   # 生成出來的英文字樣所在的橫帶
MOUTH_BOX = (159, 274, 228, 310)  # 要挖掉的嘴（左右留白給法令紋，勿放寬）
BG_TOL = 22.0
LINE, INNER, TONGUE, LIP = (64,29,14,255), (92,42,36,255), (198,110,110,255), (233,168,144,255)
DEPTH = {"closed": 0.0, "small": 7.0, "mid": 16.0, "wide": 27.0}
SS = 8  # 超取樣倍率


def inpaint(a, mask, rounds=400):
    """用未遮罩鄰居的平均值反覆填補。比單色填滿好，因為會自然接上漸層。"""
    out, m = a.copy(), mask.copy()
    H, W = a.shape[:2]
    for _ in range(rounds):
        if not m.any():
            break
        known = ((~m) & (a[:, :, 3] > 0)).astype(float) if a.shape[2] == 4 else (~m).astype(float)
        acc = np.zeros_like(out); cnt = np.zeros((H, W))
        for dy, dx in ((1,0), (-1,0), (0,1), (0,-1)):
            acc += np.roll(out * known[..., None], (dy, dx), (0,1))
            cnt += np.roll(known, (dy, dx), (0,1))
        can = m & (cnt > 0)
        out[can] = acc[can] / cnt[can][:, None]
        m &= ~can
    return out


def label(mask):
    """自己寫的連通塊標記（環境沒有 scipy）。"""
    H, W = mask.shape
    lab = np.zeros((H, W), int); n = 0
    for y0 in range(H):
        for x0 in range(W):
            if mask[y0, x0] and lab[y0, x0] == 0:
                n += 1; q = deque([(y0, x0)]); lab[y0, x0] = n
                while q:
                    y, x = q.popleft()
                    for dy, dx in ((1,0), (-1,0), (0,1), (0,-1)):
                        ny, nx = y+dy, x+dx
                        if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and lab[ny, nx] == 0:
                            lab[ny, nx] = n; q.append((ny, nx))
    return lab, n


def main(src):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(float); H, W = a.shape[:2]
    print(f"來源 {W}x{H}")

    # 1. 抹掉衣服上生成出來的字
    green = (a[:,:,1] > a[:,:,0]+25) & (a[:,:,1] > a[:,:,2]+25) & (a[:,:,1] > 60)
    gx = np.where(green)[1]
    region = np.zeros((H, W), bool)
    region[SHIRT_TEXT_ROWS[0]:SHIRT_TEXT_ROWS[1], gx.min()-8:gx.max()+9] = True
    m = region & (a.sum(axis=2) > 430)
    for _ in range(3):
        m |= np.roll(m,1,0)|np.roll(m,-1,0)|np.roll(m,1,1)|np.roll(m,-1,1)
    print(f"  抹除衣服字樣 {m.sum()} px")
    a = inpaint(np.dstack([a, np.full((H,W), 255.0)]), m)[:, :, :3]

    # 2. 去背：固定參考色 ＋ 從邊界 flood fill
    edge = np.concatenate([a[0], a[-1], a[:,0], a[:,-1]])
    REF = np.median(edge, axis=0)
    ok = np.abs(a - REF).max(axis=2) <= BG_TOL
    bg = np.zeros((H, W), bool); q = deque()
    for x in range(W):
        for y in (0, H-1):
            if ok[y,x] and not bg[y,x]: bg[y,x] = True; q.append((y,x))
    for y in range(H):
        for x in (0, W-1):
            if ok[y,x] and not bg[y,x]: bg[y,x] = True; q.append((y,x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1,0), (-1,0), (0,1), (0,-1)):
            ny, nx = y+dy, x+dx
            if 0 <= ny < H and 0 <= nx < W and ok[ny,nx] and not bg[ny,nx]:
                bg[ny,nx] = True; q.append((ny,nx))
    alpha = np.where(bg, 0.0, 255.0)
    inner = ~bg
    edge_px = inner & ~(np.roll(inner,1,0)&np.roll(inner,-1,0)&np.roll(inner,1,1)&np.roll(inner,-1,1))
    alpha[edge_px] = 190
    print(f"  去背後人物 {(alpha>0).sum()} px")

    # 3. 移除被包住的背景（腿間 ＋ 影子）：跨滿人物寬度的那一塊
    rgb = a
    lightish = (rgb.mean(axis=2) > 195) & ((rgb.max(axis=2)-rgb.min(axis=2)) < 26) & (alpha > 0)
    lab, n = label(lightish)
    ys, xs = np.where(alpha > 0)
    fig_w = xs.max() - xs.min() + 1
    for cid in range(1, n+1):
        cy, cx = np.where(lab == cid)
        if len(cy) > 800 and (cx.max()-cx.min()) > fig_w*0.5 and cy.min() > ys.min()+ (ys.max()-ys.min())*0.6:
            alpha[lab == cid] = 0
            print(f"  移除封閉背景塊 #{cid}：{len(cy)} px（腿間＋影子）")

    ys, xs = np.where(alpha > 0)
    x0, y0 = int(xs.min()), int(ys.min())
    fig = Image.fromarray(np.dstack([a.clip(0,255), alpha]).astype(np.uint8), "RGBA") \
               .crop((x0, y0, int(xs.max())+1, int(ys.max())+1))
    FW, FH = fig.size
    print(f"  立繪 {FW}x{FH}")

    # 4. 萃取微笑曲線
    fa = np.asarray(fig).astype(int)
    mx0, my0, mx1, my1 = MOUTH_BOX
    sub = fa[my0-6:my1-8, mx0-1:mx1+1, :3]
    dark = sub.sum(axis=2) < 340
    cols = [(mx0-1+i, my0-6+np.where(dark[:,i])[0].mean())
            for i in range(dark.shape[1]) if dark[:,i].any()]
    cxs = np.array([c[0] for c in cols]); cys = np.array([c[1] for c in cols])
    c = np.polyfit(cxs, cys, 2)
    print(f"  微笑曲線 y={c[0]:.5f}x²+{c[1]:.4f}x+{c[2]:.2f}  殘差 {np.abs(np.polyval(c,cxs)-cys).max():.2f}px")
    X0, X1 = int(cxs.min()), int(cxs.max())

    # 5. 挖掉嘴
    m2 = np.zeros((FH, FW), bool); m2[my0:my1, mx0:mx1] = True
    m2 &= fa[:, :, 3] > 0
    base_arr = inpaint(fa.astype(float), m2)
    base = Image.fromarray(base_arr.clip(0,255).astype(np.uint8), "RGBA")

    # 6. 畫四個嘴型
    def geom(N=160):
        pts = []
        for i in range(N+1):
            x = X0 + (X1-X0)*i/N
            t = (x-(X0+X1)/2)/((X1-X0)/2)
            yc = c[0]*x*x + c[1]*x + c[2]
            w = 1.0 + 4.0*max(0.0, 1-t*t)**0.45     # 中央 5.0 → 兩端 1.0，比對過原圖
            pts.append((x, yc, w, t))
        return pts

    os.makedirs(OUT, exist_ok=True)
    layers = {}
    for name, depth in DEPTH.items():
        L = Image.new("RGBA", (FW*SS, FH*SS), (0,0,0,0)); d = ImageDraw.Draw(L)
        P = geom()
        ot = [(x*SS, (yc-w/2)*SS) for x,yc,w,t in P]
        ob = [(x*SS, (yc+depth*max(0.,1-t*t)+w/2)*SS) for x,yc,w,t in P]
        d.polygon(ot + ob[::-1], fill=LINE)
        if depth > 0:
            it = [(x*SS, (yc+w/2)*SS) for x,yc,w,t in P]
            ib = [(x*SS, (yc+depth*max(0.,1-t*t)-w/2)*SS) for x,yc,w,t in P]
            k = [i for i in range(len(P)) if ib[i][1] > it[i][1]]
            if k: d.polygon([it[i] for i in k] + [ib[i] for i in k][::-1], fill=INNER)
            if depth >= 16:
                tt = [(x*SS,(yc+depth*max(0.,1-t*t)*0.52)*SS) for x,yc,w,t in P]
                tb = [(x*SS,(yc+depth*max(0.,1-t*t)*0.94)*SS) for x,yc,w,t in P]
                k = [i for i in range(len(P)) if tb[i][1] > tt[i][1]+2*SS]
                if k: d.polygon([tt[i] for i in k] + [tb[i] for i in k][::-1], fill=TONGUE)
        else:
            # ⚠️ 下唇高光只出現在 closed。嘴一張開它就不該在，
            # 而且 mid 的下緣正好切過它，留著會變成黏在嘴上的粉色髒點。
            lp = fa[my1-14:my1-4, mx0+20:mx1-20, :3]
            pink = (lp[:,:,0] > 225) & (lp[:,:,0]-lp[:,:,2] > 28) & (lp[:,:,1] < 200)
            if pink.any():
                py, px = np.where(pink)
                d.ellipse([(mx0+20+px.min())*SS, (my1-14+py.min())*SS,
                           (mx0+20+px.max())*SS, (my1-14+py.max())*SS], fill=LIP)
        layers[name] = L.resize((FW, FH), Image.LANCZOS)

    boxes = []
    for L in layers.values():
        al = np.asarray(L)[:, :, 3]; ly, lx = np.where(al > 0)
        boxes.append((lx.min(), lx.max(), ly.min(), ly.max()))
    bx0 = min(b[0] for b in boxes)-2; bx1 = max(b[1] for b in boxes)+3
    by0 = min(b[2] for b in boxes)-2; by1 = max(b[3] for b in boxes)+3

    base.save(f"{OUT}/base.webp", "WEBP", quality=92, method=6)
    for name, L in layers.items():
        L.crop((bx0, by0, bx1, by1)).save(f"{OUT}/mouth-{name}.webp", "WEBP", quality=95, method=6)

    print("\n把下面這組數字貼進 components/avatar/ChibiAvatar.tsx 的 MOUTH_BOX：")
    print(json.dumps({"left": f"{bx0/FW*100:.3f}%", "top": f"{by0/FH*100:.3f}%",
                      "width": f"{(bx1-bx0)/FW*100:.3f}%", "height": f"{(by1-by0)/FH*100:.3f}%",
                      "FIGURE_ASPECT": f"{FW} / {FH}"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
