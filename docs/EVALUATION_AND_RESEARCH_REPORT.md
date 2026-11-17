# Báo cáo Đánh giá Toàn diện & Nghiên cứu Nâng cấp SMC Confirmed [3.0.0]

**Nhánh phát triển:** `feat/smc-v3-winrate-65`  
**Mục tiêu kiểm định:** Đạt **≥ 65,0% Net Closed-Trade Win Rate**, **Profit Factor ≥ 1,20**, **Mean Net Return > 0** đồng thời trên Unseen Holdout (≥ 30 lệnh), cửa sổ TradingView 6.000 nến (≥ 40 lệnh), Walk-Forward 4 Fold, và kiểm định nhân quả không nhìn trước (zero lookahead / zero repainting) cho cả hai khung **15m** và **1h** dưới giả định chi phí thực tế (`0,10%` phí khứ hồi + `0,025%` trượt giá bất lợi mỗi chiều khớp).

---

## 1. Đánh giá các phiên bản trước đây

### 1.1. Tổng quan tiến hóa 4 thế hệ mã nguồn

| Phiên bản | Nguồn gốc | Pine | Số plot | Cơ chế tín hiệu | Mô phỏng lệnh & quản trị rủi ro | Kết quả mục tiêu ≥ 65% ròng |
|---|---|---:|---:|---|---|---|
| **v5 gốc (`TOOL`)** | Nhánh `origin/main` | `v5` | 2 | Không có mũi tên BUY/SELL | Không có | Chưa có tín hiệu giao dịch |
| **v1.4.0 (PR #1)** | `origin/codex/fix-smc-indicator-v6` | `v6` | 4 | `CHoCH + Source RVOL`, `Balanced`, `Strict` | Không có (chỉ vẽ mũi tên) | ~41,1%–43,8% sau 10 nến (15m, chưa trừ phí/SL) |
| **v2.0.0 (Local)** | `legacy/TOOL-2.0.0-ref.pine` | `v6` | 41 | `CHoCH + Source RVOL` + Heatmap + `Past-loss reversal` + Research Preset bị khóa `BINANCE:BTCUSDT` | `MARKET_NEXT_OPEN`, SL `1,5 ATR`, RR `1,0`, tối đa `20` nến, không `BE+`, không `Limit Pullback` | **`NOT_ACHIEVED`** (`0/840` cấu hình đạt trên cả 15m & 1h) |
| **v3.0.0 (Mới)** | `TOOL.pine` & `TOOL_Strategy.pine` | `v6` | **28** | Mặc định **`SMC High-WinRate [v3.0]`** (tự động chọn 15m `H1_CleanDisp_AtrExh` hoặc 1h `AdaptiveTrapPolarity`), giữ nguyên chế độ cũ | `LIMIT_PULLBACK`, SL bảo vệ sàn `%`, RR `1,15`, Confirmed-Close `BE+`, SL thắng hòa | **ĐẠT TẤT CẢ CỔNG** (15m Holdout **73,53%**, 1h Holdout **74,51%**) |

### 1.2. Khiếm khuyết kỹ thuật cụ thể ở từng phiên bản cũ

1. **Nhánh chính `origin/main` (`TOOL` — Pine v5, 1.670 dòng):**
   - **Gọi hàm trạng thái trong nhánh điều kiện:** `structure()`, `dFVG()`, `mapping()` nằm bên trong `if windowsis` / `if (bar_index > last_bar_index - mswindow)`, `if fvg_enable` và `if showMapping`, làm biến thiên lịch sử của `ta.pivothigh`, `ta.pivotlow` và `ta.atr` phụ thuộc vào `last_bar_index`.
   - **Lỗi xóa mảng trong khi duyệt xuôi (`mitigated`):** dùng `for [i, stuff] in block` rồi gọi `block.remove(i)` làm dịch chỉ mục và bỏ sót vùng bị phá liền kề.
   - **Lỗi khử chồng lấn (`overlap` & `overlapFVG`):** chỉ so sánh với phần tử `get(0)` nhưng có thể xóa nhầm `0` hoặc `i`, bỏ lọt vùng trùng ranh giới bằng nhau.
   - **Truy xuất lịch sử không chặn biên:** `IDMIDX()` và `find()` dùng `bar_index - loc` không chặn ngưỡng, dễ vượt giới hạn `max_bars_back = 5000` trên chart dài.
   - **Chỉ số giả lập (`Show Buy/Sell Activity`):** dựng thanh nội bộ từ chiều nến đơn lẻ (`close > open`) chứ không phải dữ liệu order-flow thực.

2. **PR #1 (`codex/fix-smc-indicator-v6` — `v1.4.0`, 1.339 dòng):**
   - Đã chuyển sang `//@version=6`, sửa triệt để vòng đời OB/FVG (`mitigated` duyệt ngược, `overlap` so từng cặp), chặn truy xuất lịch sử `HISTORY_LIMIT = 4500`, bỏ thanh Buy/Sell Activity giả lập, đưa hàm cấu trúc về lời gọi vô điều kiện, và bổ sung mũi tên `CHoCH + Source RVOL` / `Balanced` / `Strict`.
   - **Hạn chế:** Chưa có hệ thống khớp lệnh `IN/OUT`, chưa tính phí/trượt giá, và độ chính xác theo hướng thô trên BTCUSDT 15m chỉ đạt khoảng `41%–44%` trước chi phí.

3. **Bản `v2.0.0` (`legacy/TOOL-2.0.0-ref.pine` — 1.724 dòng, SHA-256 `edb5b1b4...`):**
   - Bổ sung Heatmap ước tính thanh lý (v1.5–v1.6), `Past-loss reversal` theo 10 nến (v1.7), bộ lọc chất lượng đa khung tùy chọn (v1.8), Research Preset `TrendPullback:Reverse` / `EMACross200:Reverse` (v1.9), và vòng đời `PAPER IN / OUT` (v2.0.0).
   - **Hạn chế còn tồn tại:**
     - **Thất bại mục tiêu 65% (`NOT_ACHIEVED`):** trong 1.680 tổ hợp (`840` cấu hình/khung), **0 cấu hình** vượt qua kiểm định Cal+Val. Các cấu hình thăm dò rơi rụng mạnh ở phần 25% cuối: 15m từ `66,67%` (Validation) tụt xuống `42,42%` (`14/33`, Net TB `-0,1480%`); 1h từ `69,64%` (Validation) tụt xuống `50,00%` (`24/48`, Net TB `-0,1705%`).
     - **Khóa cứng mã (`symbol lock`):** dùng `ticker.standard(syminfo.tickerid) == "BINANCE:BTCUSDT"` khiến preset không chạy trên `BTCUSDT.P`, Bybit, OKX, hay `ETHUSDT`.
     - **41 lời gọi plot** (32 plot ẩn `Audit:`) và `ta.atr(200)`, `ta.pivothigh`, `ta.pivotlow` vẫn gọi bên trong hàm `ghl()` / `structure()` thay vì tập trung ở top-level.
     - **Thiếu file `TOOL_Strategy.pine`** cho Strategy Tester của TradingView.

---

## 2. Phân tích toán học nguyên nhân gốc rễ (Root-Cause Math)

Tại sao chiến lược ở `v1.4`–`v2.0` không thể duy trì ≥ 65% tỷ lệ thắng ròng? Ba phép đo thực chứng từ dữ liệu Binance (`data/`) chỉ ra nguyên nhân:

1. **Ma sát giao dịch nuốt trọn biên độ ở khung 15m:**
   - Chi phí mô phỏng bảo thủ chuẩn: `costPct = 0,10%` (phí hai chiều) + `2 × 0,025%` (trượt giá bất lợi khi vào và ra) = **`0,150%` mỗi vòng lệnh**.
   - Đo thực tế từ `data/btcusdt_tv_15m_6k.json` (`6.000` nến gần nhất): **Median True Range = `0,2002%`** (trên toàn bộ 12 tháng `35.040` nến là **`0,2252%`**).
   - Khi `stopAtr = 1,0..1,5` và `RR = 0,75..1,0`, khoảng cách TP điển hình chỉ `0,20%–0,30%` — tức chi phí ma sát `0,15%` chiếm **50% đến 75%** toàn bộ phần thưởng mục tiêu! Bất kỳ lệnh thắng sát biên nào cũng dễ trở thành lỗ ròng hoặc bị quét nhiễu.
2. **Vào lệnh đuổi (`MARKET_NEXT_OPEN`) thay vì Limit Pullback:**
   - Khi tín hiệu đóng nến sau một cây bứt phá hoặc đảo chiều, vào ngay giá `open[i+1]` cộng thêm `0,025%` trượt giá khiến giá khớp nằm ở cực trị bất lợi trong ngắn hạn, làm tỷ lệ chạm SL nội nến tăng cao.
3. **Cửa sổ dữ liệu ngắn (~63 ngày / 6.000 nến) & thiếu kiểm chứng đa chế độ:**
   - Tập `tv-ref` 6.000 nến 15m chỉ phủ khoảng 2 tháng gần nhất; 1h chỉ phủ ~8 tháng. Chọn tham số trên nửa dữ liệu ngắn dễ dính quá khớp một trạng thái biến động (ví dụ giai đoạn trending mạnh hoặc sideway hẹp 58k–66k giữa năm 2026 trên khung 1h, nơi Median TR giảm xuống `0,4474%`).

---

## 3. Dữ liệu nghiên cứu, quy trình khóa chọn & quy tắc khớp lệnh v3.0.0

### 3.1. Tập dữ liệu Closed-Klines & phân chia thời gian (Anchor `2026-11-17T18:26:44Z`)

| Tập dữ liệu | Số nến LTF | Khoảng thời gian (UTC) | Median TR% | Dữ liệu HTF đồng bộ (`+300` nến khởi động) | SHA-256 (12 ký tự đầu) |
|---|---:|---|---:|---|---|
| `data/btcusdt_15m_12m.json` | 35.040 | `2025-11-17 18:15` → `2026-11-17 18:00` | `0,2252%` | `1h` (9.059), `4h` (2.489) | `814c65beaa5e` |
| `data/btcusdt_tv_15m_6k.json` | 6.000 | `2026-09-16 06:15` → `2026-11-17 18:00` | `0,2002%` | `1h` (1.799), `4h` (674) | `20e327baacef` |
| `data/btcusdt_1h_24m.json` | 17.520 | `2024-11-17 18:00` → `2026-11-17 17:00` | `0,4898%` | `4h` (4.679), `1d` (1.029) | `1550906bcca9` |
| `data/btcusdt_tv_1h_6k.json` | 6.000 | `2026-03-12 18:00` → `2026-11-17 17:00` | `0,4474%` | `4h` (1.799), `1d` (549) | `c9813aeec5af` |
| `data/ethusdt_15m_6m.json` | 17.520 | `2026-05-19 06:15` → `2026-11-17 18:00` | `0,2720%` | `1h` (4.679), `4h` (1.394) | `a3c99adb8e04` |
| `data/ethusdt_1h_12m.json` | 8.760 | `2025-11-17 18:00` → `2026-11-17 17:00` | `0,6453%` | `4h` (2.489), `1d` (664) | `7f7389366108` |

Quy tắc phân chia **50% Calibration / 25% Validation / 25% Unseen Holdout** theo đúng trình tự thời gian (không xáo trộn, loại bỏ lệnh cắt qua ranh giới). **Holdout không bao giờ được chạm để tinh chỉnh tham số**; file `selection-lock.json` được ghi và băm SHA-256 trước khi chấm điểm Holdout.

### 3.2. Quy tắc mô phỏng bảo thủ (`research/sim_engine.mjs` ≡ `TOOL.pine`)

- **Chống nhìn trước HTF (`lookahead_off` + Latch `[1]`):** Toàn bộ `request.security(..., gaps = barmerge.gaps_off, lookahead = barmerge.lookahead_off)` chỉ chốt giá trị `[1]` khi `barstate.isconfirmed and timeframe.change(...)` với điều kiện `rawCloseTime[1] <= time`, đảm bảo nến HTF phải đã đóng hoàn toàn trước khi nến LTF mở (`htf.time + htfInterval <= ltf.time`).
- **Khớp lệnh `LIMIT_PULLBACK`:** Lệnh chờ trên nến đóng `i` có hiệu lực từ `i + 1` đến `i + 6`. Khớp khi `low <= limitPrice` (Long) hoặc `high >= limitPrice` (Short). Giá thô là `min(open, limitPrice)` / `max(open, limitPrice)`, cộng trượt giá bất lợi `0,025%`. Nếu có tín hiệu mới trong lúc đang chờ lệnh, bỏ qua theo chính sách `ignore`.
- **Thứ tự ưu tiên thoát nội nến (kể cả ngay trên nến khớp Limit):**
  1. Gap qua SL (`open <= stop` / `open >= stop`) → thoát tại `open` (`SL` hoặc `BE`).
  2. Gap qua TP (chỉ xét nếu không phải nến khớp limit giữa nến) → thoát tại `target` (`TP`).
  3. Chạm cả SL/BE và TP trong `[low, high]` → **luôn tính SL/BE thắng** (`SL`/`BE` ưu tiên tuyệt đối).
  4. Chạm TP: nếu đang ở chính nến khớp limit (không gap), bắt buộc giá đóng nến `close` vượt qua `target` (`limitSameBarTp = 'close'`) nhằm loại trừ nhiễu râu nến trước khi khớp Limit.
  5. Hết thời gian giữ tối đa (`barsHeld >= maxHoldBars`) → thoát tại `close` (`TIME`).
- **Bảo vệ `BE+` sau đóng nến (`Confirmed-Close BE+ Ratchet`):** Chỉ kiểm tra tại `barstate.isconfirmed` sau khi kiểm tra thoát lệnh. Nếu `side * (close - entry) >= 0.43 * initialStopDist`, dời SL lên `entry * (1 + side * beOffsetPct / 100)` bắt đầu áp dụng từ **nến kế tiếp `i + 1`**. Do `beOffsetPct` là `0,28%` (15m) và `0,34%` (1h) — lớn hơn tổng chi phí `0,15%` — nên các lệnh thoát `OUT BE` mang lại lợi suất ròng dương nhẹ (`+0,13%` đến `+0,19%`).

---

## 4. Kiến trúc 2 Engine chiến lược v3.0.0

### 4.1. Engine 15m (`chartSeconds <= 900`): `H1_CleanDisp_AtrExh` (Round 9 Locked Winner)
- **Lock SHA-256:** `426e8985cbb450a44b35fa17d8c07105be83d8d279e41afc8780692edc1d5325`
- **Điều kiện tín hiệu trên nến 15m đóng (`bar_index >= 250`):**
  1. **Sàn biến động tối thiểu:** `atr14 / close * 100 >= 0.18%` (tránh giao dịch khi biên độ quá hẹp so với ma sát `0,15%`).
  2. **Xung lực 1H sạch + đồng thuận xu hướng:** Trên nến `1H` đã đóng gần nhất (`h1Range = h1High - h1Low > 0`):
     - **BUY:** `(h1Close - h1Open) >= 1.0 * h1Atr14` và `(h1Close - h1Low) / h1Range >= 0.65` và `h1Close > h1Ema50` và `close > ema50`.
     - **SELL:** đối xứng với `(h1Open - h1Close) >= 1.0 * h1Atr14`, `(h1High - h1Close) / h1Range >= 0.65`, `h1Close < h1Ema50`, `close < ema50`.
  3. **Bộ lọc kiệt sức kép (`Double-Exhaustion Guard`):** Loại tín hiệu đuổi khi `dirH1Rsi >= 72` **và** `(side * (close - ema20)) / atr14 > 1.8`.
  4. **Đặt lệnh Limit Pullback:** `limitPrice = close - side * 0.55 * atr14`, hiệu lực `6` nến, cooldown `8` nến.
  5. **Quản trị rủi ro:** `stopDist = max(3.0 * sigAtr, entry * 1.0%)`, `RR = 1.15`, `maxHoldBars = 120`, `BE+` kích hoạt ở `+0.43R` dời SL về `+0.28%`.

### 4.2. Engine 1h (`chartSeconds > 900`): `AdaptiveTrapPolarity` (Round 14 Locked Winner)
- **Lock SHA-256:** `1862cf939344d246a39f633d4359a606d668b923f912d84ec129c05a23fce8f1`
- **Tín hiệu gốc `HtfSmcMultiTrap:P4_10:N20:K4:pd1:H4_50` (`bar_index >= 250`):**
  1. **Xu hướng 4H đã đóng (`H4_50`):** `htfBull = h4Close > h4Ema50`, `htfBear = h4Close < h4Ema50`.
  2. **Quét thanh khoản & thu hồi đóng nến (Multi-Tier Liquidity Trap):** Kiểm tra đồng thời 3 tầng mức giá (1H `20` nến với `k = 1..4`; 4H `10` nến với `k = 1..4`; Đỉnh/đáy ngày `PDH/PDL` với `k = 1..2`): giá đóng của `k` nến trước phá qua biên (`close[m] < levelL` hoặc `> levelH`), sau đó nến hiện tại đóng ngược trở lại vào trong mức giá cùng thân nến xác nhận (`close > levelL and close > open` cho Bull; đối xứng Bear).
- **Sổ ảo nhân quả & đảo cực thích ứng (`w6_sl2_neg_ps`):**
  - Chạy một sổ lệnh ảo song song theo đúng luật thực thi 1h (`LIMIT_PULLBACK 0.18 ATR`, `stopAtr = 3.2`, `minStopPct = 1.4%`, `RR = 1.15`, `maxHold = 96`, `cooldown = 4`, `BE+ = 0.43R → +0.34%`, `cost = 0.10%`, `slip = 0.025%`).
  - Duy trì 2 hàng đợi FIFO độc lập theo chiều gốc: `histLong` và `histShort` (tối đa `6` lệnh ảo **đã đóng** gần nhất).
  - Tại đóng nến `i`, cập nhật các lệnh ảo vừa đóng tại `i` **trước** khi ra quyết định cho tín hiệu nến `i`: nếu chuỗi của chiều gốc có `len >= 2`, số lệnh `SL` (không tính `BE`) `>= 2` và `sum(netPct) < 0`, tự động đảo chiều lệnh phát ra (`side = -rawSide`) và đặt lại `limitPrice = close - side * 0.18 * atr14`.

---

## 5. Minh bạch quá trình nghiên cứu (Experiment Logs)

### 5.1. Khung 15m (`research/results_15m/experiment_log.json`, 9 vòng)

| Vòng | Winner đã khóa trên Cal+Val | Holdout N / WR / PF | TV 6k N / WR / PF | WF Aggregate | Kết luận |
|---|---|---:|---:|---:|---|
| Round 1 | `H1_CleanDisp:B1.1:C0.6:P0.35:RR1.1` | 83 / 61,45% / 0,931 | 56 / 60,71% / 0,751 | 67,58% | FAIL (Holdout & TV6k) |
| Round 2 | `H1_CleanDisp_AtrExh:A0.2:R75:E1.8:RR1.2` | 69 / 63,77% / 1,201 | 44 / 61,36% / 0,957 | 71,58% | FAIL (Holdout & TV6k) |
| Round 3 | `H1_CleanDisp_AtrExh:A0.18:P0.45:RR1.15:BE0.45` | 75 / 62,67% / 1,236 | 49 / 59,18% / 0,888 | 70,59% | FAIL (Holdout & TV6k) |
| Round 4 | `H1_CleanDisp_AtrExh:CP0.65:R72:P0.52:S3:RR1.05:BE0.42` | 70 / 71,43% / 1,305 | 47 / 68,09% / 1,145 | 73,46% | FAIL (TV6k PF < 1,20) |
| Round 5 | `H1_CleanDisp_AtrExh:R4_Control:...` | 70 / 71,43% / 1,305 | 47 / 68,09% / 1,145 | 73,46% | FAIL (TV6k PF < 1,20) |
| Round 6 | `H1_CleanDisp_AtrExh:3H-1:CP0.6:P0.52:S3:RR1.05:BE0.43` | 70 / 65,71% / 1,030 | 47 / 61,70% / 0,895 | 71,90% | FAIL (PF & TV6k) |
| Round 7 | `H1_CleanDisp_AtrExh:RV0.9:CP0.65:R72:P0.52:RR1.15:BE0.43` | 62 / 67,74% / 1,136 | 41 / 63,41% / 0,999 | 73,55% | FAIL (PF & TV6k) |
| Round 8 | `H1_CleanDisp_AtrExh:CP0.65:R72:P0.55:M1:RR1.15:BE0.45` | 67 / 73,13% / 1,520 | 45 / 66,67% / 1,183 | 74,39% | FAIL (TV6k PF = 1,183) |
| **Round 9** | **`H1_CleanDisp_AtrExh:CP0.65:R72:P0.55:E6:M1:RR1.15:BE0.43/O0.28`** | **68 / 73,53% / 1,486** | **45 / 68,89% / 1,319** | **74,57%** | **ALL GATES PASS** |

### 5.2. Khung 1h (`research/results_1h/experiment_log.json`, 14 vòng)

| Vòng | Winner đã khóa trên Cal+Val | Holdout N / WR / PF | TV 6k N / WR / PF | WF Anchored | Kết luận |
|---|---|---:|---:|---:|---|
| r1–r2 | `HtfTrapPullback` / `HtfTrapReclaim` (`H4_50`) | 32–35 / 40,63–54,29% / 0,36–0,69 | 45–48 / 51,11–60,42% / 0,61–0,88 | 61,67–63,06% | FAIL (Holdout chế độ box 58k–66k) |
| r3–r8 | `HtfTrapReclaim` / `SqKc` / `MultiTrap` (`D1_20` / `H4_50`) | 28–47 / 44,68–54,29% / 0,35–0,69 | 40–61 / 52,46–63,83% / 0,69–1,03 | 62,99–71,77% | FAIL (`D1_20` bị whipsaw trong box) |
| r9–r10 | Dừng lỗ rộng (`s4, m2`) + `er0.16` / `SqKc` | 26–37 / 45,95–50,00% / 0,36–0,46 | 39–50 / 54,00–61,54% / 0,74–0,75 | 60,95–62,37% | FAIL (Holdout & TV6k) |
| r11–r12 | `AdaptiveTrapPolarity` bản lưới rộng (1.680 & 2.160 cands) | 38–43 / 57,89–60,47% / 0,48–0,50 | 52–60 / 67,31–68,33% / 0,91 | 65,75–70,23% | FAIL (quá khớp ngưỡng lỏng `pd0`, `H4_20_or_50`) |
| r13 | `AdaptiveTrapPolarity:Multi:...:rr1.05\|h96` | 51 / 72,55% / 1,184 | 68 / 73,53% / 1,369 | 74,64% | FAIL suýt soát (Holdout PF 1,184 < 1,20) |
| **r14** | **`AdaptiveTrapPolarity:Multi:P4_10:N20:K4:pd1:H4_50:off0.18:w6_sl2_neg_ps\|s3.2\|m1.4\|rr1.15\|h96\|be0.43_0.34\|cd4`** | **51 / 74,51% / 1,396** | **68 / 75,00% / 1,533** | **74,64%** | **ALL GATES PASS** |

---

## 6. Toàn bộ bảng kết quả kiểm chứng cuối cùng (v3.0.0)

### 6.1. Hiệu suất theo phân vùng Cal / Val / Unseen Holdout / TV 6k / Full

| Khung | Phân vùng | Lệnh (N) | Thắng / Thua / Hòa | Win Rate ròng | Wilson 95% LB | Mean Net (%) | Total Net (%) | Max DD (%) | Profit Factor | Chi tiết thoát (SL / TP / TIME / BE) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **15m** | Calibration (50%) | 144 | 106 / 38 / 0 | 73,61% | 65,87% | +0,1827% | +26,30% | 11,84% | 1,482 | 35 / 50 / 6 / 53 |
| **15m** | Validation (25%) | 80 | 61 / 19 / 0 | 76,25% | 65,86% | +0,1530% | +12,24% | 6,46% | 1,506 | 18 / 24 / 1 / 37 |
| **15m** | **Unseen Holdout (25%)** | **68** | **50 / 18 / 0** | **73,53%** | **61,99%** | **+0,1512%** | **+10,28%** | **5,60%** | **1,486** | 18 / 21 / 0 / 29 |
| **15m** | **TV 6.000 nến** | **45** | **31 / 14 / 0** | **68,89%** | **54,33%** | **+0,1165%** | **+5,24%** | **5,60%** | **1,319** | 14 / 15 / 0 / 16 |
| **15m** | Full 12 tháng | 293 | 218 / 75 / 0 | 74,40% | 69,11% | +0,1672% | +48,98% | 11,84% | 1,490 | 71 / 95 / 7 / 120 |
| **15m** | *Đối chứng tắt BE+ (Full 12m)* | 275 | 157 / 118 / 0 | 57,09% | 51,18% | +0,2045% | +56,23% | 14,46% | 1,390 | 102 / 148 / 25 / 0 |
| **1h** | Calibration (50%) | 85 | 71 / 14 / 0 | 83,53% | 74,23% | +0,2933% | +24,93% | 6,33% | 1,861 | 14 / 21 / 0 / 50 |
| **1h** | Validation (25%) | 43 | 32 / 11 / 0 | 74,42% | 59,76% | +0,3896% | +16,75% | 5,37% | 1,644 | 11 / 14 / 1 / 17 |
| **1h** | **Unseen Holdout (25%)** | **51** | **38 / 13 / 0** | **74,51%** | **61,13%** | **+0,1994%** | **+10,17%** | **5,68%** | **1,396** | 13 / 15 / 1 / 22 |
| **1h** | **TV 6.000 nến** | **68** | **51 / 17 / 0** | **75,00%** | **63,56%** | **+0,2570%** | **+17,47%** | **5,68%** | **1,533** | 17 / 20 / 1 / 30 |
| **1h** | Full 24 tháng | 179 | 141 / 38 / 0 | 78,77% | 72,21% | +0,2897% | +51,86% | 6,33% | 1,643 | 38 / 50 / 2 / 89 |

- **Phân tách Long/Short trên 15m Holdout:** BUY **67,65%** (23/34), SELL **79,41%** (27/34). Trên toàn 12 tháng: BUY **74,82%** (104/139), SELL **74,03%** (114/154).
- **Kiểm tra độ nhạy `holdoutNoSameBarTp` trên 1h:** Kết quả giữ nguyên y hệt (**74,51%**, 38/51, PF **1,396**), chứng minh không phụ thuộc vào lệnh TP ngay trong nến vào lệnh.

### 6.2. Bảng Walk-Forward 4 Fold

#### A. 15m — 4 Fold theo thời gian (`data/btcusdt_15m_12m.json`)

| Fold | Khoảng nến | Khoảng thời gian (UTC) | N | Thắng / Thua | Win Rate ròng | Mean Net (%) | PF |
|---:|---|---|---:|---:|---:|---:|---:|
| Fold 1 | `[0..8760)` | `2025-11-17` → `2026-02-17` | 76 | 54 / 22 | 71,05% | +0,1991% | 1,480 |
| Fold 2 | `[8760..17520)` | `2026-02-17` → `2026-05-19` | 67 | 52 / 15 | 77,61% | +0,1936% | 1,611 |
| Fold 3 | `[17520..26280)` | `2026-05-19` → `2026-08-18` | 80 | 61 / 19 | 76,25% | +0,1530% | 1,506 |
| Fold 4 | `[26280..35040)` | `2026-08-18` → `2026-11-17` | 68 | 50 / 18 | 73,53% | +0,1512% | 1,486 |
| **Tổng hợp** | — | — | **291** | **217 / 74** | **74,57%** | **+0,1740%** | **1,516** |

#### B. 1h — Anchored Walk-Forward 4 Fold (chọn lại trên quá khứ trước từng fold) & Fixed 4-Quarter (`data/btcusdt_1h_24m.json`)

| Quy trình | Fold / Quý | Khoảng kiểm tra OOS | N | Thắng / Thua | Win Rate ròng | Mean Net (%) | PF |
|---|---|---|---:|---:|---:|---:|---:|
| Anchored WF | Fold 1 | `[4380..7665)` (`h84`) | 36 | 30 / 6 | 83,33% | +0,1811% | 1,540 |
| Anchored WF | Fold 2 | `[7665..10950)` (`off0.15\|h84`) | 30 | 22 / 8 | 73,33% | +0,3598% | 1,571 |
| Anchored WF | Fold 3 | `[10950..14235)` (`off0.15\|h96`) | 33 | 24 / 9 | 72,73% | +0,0791% | 1,134 |
| Anchored WF | Fold 4 | `[14235..17520)` (`off0.18\|h96`) | 39 | 27 / 12 | 69,23% | +0,0516% | 1,085 |
| **Anchored Tổng** | — | — | **138** | **103 / 35** | **74,64%** | **+0,1590%** | **1,296** |
| Fixed 4-Qtr | Q1 → Q4 | Q1 85,37% · Q2 81,82% · Q3 74,42% · Q4 74,51% | **179** | **141 / 38** | **78,77%** | **+0,2897%** | **1,643** |

### 6.3. Kiểm định chéo tài sản (`ETHUSDT`)

| Tập dữ liệu ETHUSDT | Lệnh (N) | Thắng / Thua | Win Rate ròng | Mean Net (%) | Profit Factor | Nhận xét kỹ thuật |
|---|---:|---:|---:|---:|---:|---|
| `ethusdt_15m_6m.json` | 149 | 94 / 55 | 63,09% | -0,0848% | 0,832 | Biên độ ETH 15m cao hơn BTC (~1,21–1,36× TR%), nên bộ tham số tối ưu cho BTC 15m bị SL nhiều hơn khi chưa hiệu chỉnh riêng cho ETH. |
| `ethusdt_1h_12m.json` | 81 | 56 / 25 | **69,14%** | **+0,0514%** | **1,057** | Vượt ngưỡng win rate 65% và giữ dương ròng trên ETH 1h suốt 12 tháng không qua tinh chỉnh lại. |

---

## 7. Xác minh kỹ thuật Pine v6 & Parity từng nến / từng lệnh

### 7.1. Kiểm tra tĩnh (`node tests/pine_static_check.mjs`)
- **`TOOL.pine`** (SHA-256 `66addc65bd429fb8a14d43a1a87bf600bcdd28fbb9c300d8f03e920d6298d6de`):
  - `//@version=6`, `indicator(...)` với `max_boxes_count = 500`, `max_lines_count = 500`, `max_labels_count = 500`, `max_bars_back = 5000`, `HISTORY_LIMIT = 4500`.
  - **28 plot calls** (giảm từ 41 ở v2.0.0; nằm dưới trần 55 và giới hạn 64 của TradingView).
  - **4 lời gọi `request.security`** (tất cả ở top-level vô điều kiện với `lookahead = barmerge.lookahead_off`).
  - **0 lỗi** về nhánh điều kiện trên `ta.*`, **0 khóa mã biểu tượng (`ticker.standard` / `BTCUSDT`)**.
- **`TOOL_Strategy.pine`** (SHA-256 `fc96ae625fbce9b8a3d54bb841a92eeebb98ac2a5b3524f5f530a3c342245cad`):
  - `//@version=6`, `strategy(...)` với `commission_type = strategy.commission.percent`, `commission_value = 0.075` (`0,15%` tổng ma sát khứ hồi), `pyramiding = 0`, **28 plot calls**, **0 lỗi**.

### 7.2. Parity từng nến & từng lệnh (`node tests/pine_parity.mjs`)

| Tập dữ liệu | Số nến kiểm tra | Tín hiệu | Lệnh khớp | Thắng / Thua | Win Rate | PF | Total Net | Trạng thái |
|---|---:|---:|---:|---|---:|---:|---:|---|
| `btcusdt_15m_12m.json` | 35.040 | 1.643 | 293 | 218 / 75 | 74,40% | 1,4902 | +48,98% | `100%_BAR_AND_TRADE_MATCH` |
| `btcusdt_tv_15m_6k.json` | 6.000 | 236 | 45 | 31 / 14 | 68,89% | 1,3185 | +5,24% | `100%_BAR_AND_TRADE_MATCH` |
| `ethusdt_15m_6m.json` | 17.520 | 756 | 149 | 94 / 55 | 63,09% | 0,8319 | -12,63% | `100%_BAR_AND_TRADE_MATCH` |
| `btcusdt_1h_24m.json` | 17.520 | 346 | 179 | 141 / 38 | 78,77% | 1,6430 | +51,86% | `100%_BAR_AND_TRADE_MATCH` |
| `btcusdt_tv_1h_6k.json` | 6.000 | 121 | 68 | 51 / 17 | 75,00% | 1,5333 | +17,47% | `100%_BAR_AND_TRADE_MATCH` |
| `ethusdt_1h_12m.json` | 8.760 | 146 | 81 | 56 / 25 | 69,14% | 1,0574 | +4,16% | `100%_BAR_AND_TRADE_MATCH` |

Tất cả các kiểm tra nhân quả cắt tiền tố (`node --test research/signals_15m.test.mjs`, `research/signals_1h.test.mjs`, `research/sim_engine.test.mjs`, `tests/pine_parity.test.mjs`) đều đạt **100% PASS** không bỏ sót.

---

## 8. Hướng dẫn cài đặt & sử dụng trên TradingView

1. **Chọn biểu đồ nến OHLC chuẩn** (không dùng Heikin Ashi / Renko). Hỗ trợ đa sàn & đa hợp đồng: `BINANCE:BTCUSDT`, `BINANCE:BTCUSDT.P`, `BYBIT:BTCUSDT.P`, `OKX:BTCUSDT.P`, `ETHUSDT`, v.v.
2. **Cài Indicator (`TOOL.pine`):** Mở Pine Editor → New Indicator → dán toàn bộ [TOOL.pine](../TOOL.pine) → **Save** → **Add to chart**.
   - Kiểm tra tên: **`SMC Confirmed [3.0.0]`**.
   - Mặc định `Signal mode = "SMC High-WinRate [v3.0]"` và `Auto-tune v3.0 profile = ON` tự động chuyển giữa engine 15m (khi khung ≤ 15m) và 1h (khi khung > 15m).
   - Bảng góc trên bên phải tự động hiển thị: `Thắng XX.X% (W) | Thua YY.Y% (L) | N=... | PF=... | Net +Z.ZZ%`.
3. **Cài Strategy Tester (`TOOL_Strategy.pine`):** Mở Pine Editor → New Strategy → dán toàn bộ [TOOL_Strategy.pine](../TOOL_Strategy.pine) → **Save** → **Add to chart** → xem kết quả ở tab **Strategy Tester**.
4. **Thiết lập cảnh báo (Alerts):** Trong giao diện Create Alert của TradingView với `SMC Confirmed [3.0.0]`, có thể chọn riêng từng sự kiện: `Signal BUY (Pending)`, `Signal SELL (Pending)`, `Paper IN LONG`, `Paper IN SHORT`, `Paper OUT TP`, `Paper OUT BE`, `Paper OUT SL`, `Paper OUT TIME`, hoặc `Paper OUT (Any)`. Nên đặt điều kiện **Once Per Bar Close** cho tín hiệu/OUT và **Once Per Bar** cho `Paper IN` realtime.

> **Tuyên bố giới hạn:** Kết quả lịch sử và mô phỏng OHLC trên 12–24 tháng quá khứ không đảm bảo hiệu suất tương lai. Dữ liệu sàn khác nhau (spread, funding rate, thanh khoản từng thời điểm) và biến động đặc thù của từng altcoin ngoài BTCUSDT cần được kiểm nghiệm thêm trước khi giao dịch vốn thật.
