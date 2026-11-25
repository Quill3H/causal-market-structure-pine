# Báo Cáo Kiểm Định & Phân Tích v7.0: Giới Hạn Lợi Nhuận `>= 75% Win Rate` & `+30%/Tháng` Trong 5 Năm (Zero Liquidation)

**Trạng thái kiểm định (`verifier-v5`):** ✅ **PASS — Kiểm định nhân quả `15m + 1h`, vật lý thanh lý nội nến (`LIQUIDATION`), Zero-Leakage Y5, Parity `< 1e-12` Python vs JS cho cả 8 mô hình v7.0 & bảo mật Standalone.**  
**Dữ liệu:** 4 đồng Crypto 5 năm `15m` (175.808 nến/coin) + `1h` (43.952 nến/coin), đầy đủ `takerBuyVol` & 5.495 kỳ funding 8h thực tế (`2021-11-20` -> `2026-11-25`) | **Kiểm tra chéo thêm:** Futures Mỹ `1h` 2 năm (`ES=F`, `NQ=F`).

---

## 1. Câu Trả Lời Thẳng Thắn: Có Thể Giữ `WR >= 75%` VÀ Đạt `>= +30%/Tháng` Liên Tục Trong 5 Năm Không?

**Câu trả lời trung thực từ mô phỏng 5 năm không gian lận & không che giấu thanh lý (`mmr = 0.005`, `liquidationCount === 0`):**

1. **Trên tập thiết kế `Cal + Val [0..80%)` (49 tháng dương lịch UTC, ~4 năm đầu):**
   - **CÓ** (dưới khớp Limit `EXCHANGE_POST_ONLY`): gói **`TIER_3_TARGET_30MO_75WR`** (`levScale = 2.0`, trần đòn bẩy danh mục `maxTotalOpenLev = 10.0`) đạt **`+31,65%/tháng` (Monthly Profit-Sweep)** với **Win Rate `78,43%`**, **`PF 1.58`**, **`46,94%` số tháng đạt `>= +30%`** và **0 lần thanh lý (`liquidationCount = 0`)**. Mức trần sweep không cháy trên `Cal+Val` thử nghiệm được là `+96,75%/tháng`.
2. **Trên toàn bộ 5 năm `Full 5Y` (61 tháng UTC, gồm cả 13 tháng Blind Holdout Y5 thị trường gấu chưa từng chạm khi tối ưu):**
   - **Win Rate VẪN GIỮ TRÊN 75%** (`76,71%` dưới `EXCHANGE_POST_ONLY` | `75,72%` dưới `STRICT_TAKER`) và **`liquidationCount = 0`** trên cả 61 tháng ở cả hai chế độ *Monthly Profit-Sweep* lẫn *Compounded*.
   - **NHƯNG tốc độ bình quân 61 tháng dừng ở `+24,87%/tháng` (`EXCHANGE_POST_ONLY`) và `+18,42%/tháng` (`STRICT_TAKER`) — KHÔNG đạt mốc `+30%/tháng` trên toàn chu kỳ 5 năm.**
   - **Nguyên nhân thực tế:** Khi bước vào 13 tháng cuối chưa từng nhìn thấy (**Blind Holdout Y5**, thị trường giảm mạnh `-32%` BTC đến `-48%` SOL), `TIER_3` chỉ đạt **WR `69,38%` (`PF 0.92`)** và **lỗ trung bình `-1,90%/tháng` (`EXCHANGE_POST_ONLY`)** hoặc **`-8,61%/tháng` (`STRICT_TAKER`)**, với tháng tệ nhất **`-59,19%`** (Post-Only) / **`-61,09%`** (Taker) và Max Compounded Drawdown lên tới **`85,47%–92,84%`**.
3. **Kết luận thực tế cho nhà giao dịch:**
   - Để chạm `+30%/tháng` trung bình lúc thị trường thuận (`Cal+Val`), phải trả giá bằng mức rủi ro rút vốn cực lớn (`Sweep DD 108,16%`, `Compounded DD 85,47%`) khi gặp chu kỳ gấu như Y5.
   - Do đó, **mặc định an toàn trong hệ thống Standalone là `SAFE_75WR`** (`levScale = 0.75`), tiếp theo là **`BALANCED_75WR`** (`levScale = 1.0`), còn **`TARGET_30MO_75WR`** chỉ dùng cho mục đích nghiên cứu biên rủi ro cao.

---

## 2. Cơ Chế Mô Phỏng & Khắc Phục Ảo Giác Backtest Trong `sim_engine_v7.mjs`

1. **Thoát lệnh 2 chặng High-WR (`Two-Stage Maker Exit`):** Chốt một phần `TP1` (45%–55% vị thế ở `0.45R–0.70R`) bằng lệnh Maker (`tp1FeeMode='MAKER'`), kéo dừng lỗ lên khóa lãi dương (`Micro-BE+` hoặc `tp1LockOffsetR`), giúp giữ Win Rate cao mà vẫn giữ được phần runner khi đúng xu hướng.
2. **Vật lý thanh lý nội nến (`Intra-Bar Liquidation Physics`, `mmr = 0.005`):**
   - Ở cả single-stream (`isolatedLiqCheck`) và multi-stream (`simulatePortfolioV7`), engine kiểm tra **râu nến xấu nhất (`low` cho Long / `high` cho Short) TRƯỚC KHI kiểm tra TP/BE/SL**.
   - Nếu giá chạm ngưỡng duy trì ký quỹ (equity mark-to-market `<= mmr * notional`), vị thế/danh mục bị đóng ngay với `exitReason = 'LIQUIDATION'`, **`netPct = -100%`, `equity = 0`**, và ghi nhận `liquidationCount++`.
3. **Phân biệt rõ *Monthly Profit-Sweep* vs *Compounded Growth* (`summarizeMonthlyCashflowV7`):**
   - **Monthly Profit-Sweep:** Rút lãi / bù vốn về `1.0` mỗi đầu tháng UTC (liệt kê đủ **61 tháng** cho Full 5Y, gồm cả tháng có `0` lệnh để không thổi phồng trung bình). `meanMonthlySweepPct` phản ánh thu nhập rút ra trung bình hàng tháng tính trên vốn gốc `1.0`.
   - **Compounded Growth:** Lãi kép toàn phần qua các tháng, phản ánh bằng `compoundedNetPct`, `cagrPct`, `geomMonthlyPct`, và `maxCompoundedDdPct`.

---

## 3. So Sánh 3 Cấp Độ Rủi Ro Danh Mục (`frontier_75wr_30mo_summary.json`)

Danh mục được sàng lọc **chỉ trên `Cal + Val [0..80%)`** gồm 5 luồng đạt ngưỡng `WR >= 75% & PF >= 1.25`: **`BTC_15m`, `SOL_15m`, `SOL_1h`, `ETH_15m`, `ETH_1h`** (`BNB_1h` WR `73,45%` và `BNB_15m` PF `1.04` bị loại ngay từ bước sàng lọc Cal+Val, không nhìn Blind Holdout Y5).

### 3.1. Dưới hồ sơ `EXCHANGE_POST_ONLY` (Limit Maker + Funding thực 8h, `maxTotalOpenLev = 10.0`)

| Cấp độ (`Risk Tier`) | Giai đoạn | Số lệnh | Win Rate | PF | **Monthly Sweep (`%/mo`)** | Trung vị (`%/mo`) | Tháng >= +30% | Tháng dương | Tháng xấu nhất | Sweep DD | **Compounded (%) / CAGR** | Comp DD | **Liq** |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- | ---: | ---: |
| **`SAFE_75WR`** (`0.75x`) | Cal+Val (49m) | 1.375 | 78,47% | 1,59 | **+10,77%** | +10,17% | 12,24% | 71,43% | -9,43% | 15,41% | +10.458,17% / 219,53% | 23,33% | **0** |
| **`SAFE_75WR`** (`0.75x`) | **Blind Y5 (13m)** | 321 | 69,47% | 0,90 | **-1,70%** | +1,56% | 0,00% | 61,54% | -27,70% | 45,98% | -27,23% / -27,17% | 47,69% | **0** |
| **`SAFE_75WR`** (`0.75x`) | **Full 5Y (61m)** | 1.700 | **76,76%** | **1,42** | **+8,25%** | +5,84% | 9,84% | 68,85% | -27,70% | 45,98% | **+7.454,52%** / 136,92% | 47,69% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | Cal+Val (49m) | 1.375 | 78,47% | 1,59 | **+14,69%** | +13,67% | 18,37% | 67,35% | -12,82% | 21,08% | +44.006,17% / 356,37% | 30,28% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | **Blind Y5 (13m)** | 321 | 69,47% | 0,90 | **-2,16%** | +1,86% | 0,00% | 61,54% | -35,31% | 60,11% | -36,32% / -36,24% | 58,77% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | **Full 5Y (61m)** | 1.700 | **76,76%** | **1,42** | **+11,29%** | +7,69% | 14,75% | 65,57% | -35,31% | 60,11% | **+27.355,04%** / 206,47% | 58,77% | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | **Cal+Val (49m)** | 1.372 | **78,43%** | 1,58 | **+31,65%** | +27,04% | **46,94%** | 65,31% | -27,09% | 49,63% | +5.652.886,77% / 1430,47% | 53,71% | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | **Blind Y5 (13m)** | 320 | 69,38% | 0,92 | **-1,90%** | +1,97% | 7,69% | 61,54% | **-59,19%** | 108,16% | -62,70% / -62,60% | **85,47%** | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | **Full 5Y (61m)** | 1.696 | **76,71%** | **1,42** | **+24,87%** | +15,20% | **39,34%** | 63,93% | **-59,19%** | **108,16%** | **+2.008.476,79%** / 621,45% | **85,47%** | **0** |

### 3.2. Dưới hồ sơ khắc nghiệt `STRICT_TAKER` (Khớp thị trường + Slippage 2 chiều + Funding thực 8h)

| Cấp độ (`Risk Tier`) | Giai đoạn | Số lệnh | Win Rate | PF | **Monthly Sweep (`%/mo`)** | Tháng >= +30% | Tháng xấu nhất | Sweep DD | **Compounded (%)** | Comp DD | **Liq** |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`SAFE_75WR`** (`0.75x`) | Cal+Val (49m) | 1.385 | 77,55% | 1,45 | **+8,79%** | 8,16% | -15,13% | 22,79% | +4.185,27% | 27,06% | **0** |
| **`SAFE_75WR`** (`0.75x`) | **Blind Y5 (13m)** | 321 | 68,22% | 0,80 | **-4,13%** | 0,00% | -28,98% | 72,24% | -47,18% | 60,15% | **0** |
| **`SAFE_75WR`** (`0.75x`) | **Full 5Y (61m)** | 1.710 | **75,79%** | **1,29** | **+6,14%** | 4,92% | -28,98% | 72,24% | +2.122,91% | 60,15% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | Cal+Val (49m) | 1.385 | 77,55% | 1,45 | **+11,97%** | 18,37% | -19,81% | 30,68% | +13.139,27% | 35,06% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | **Blind Y5 (13m)** | 321 | 68,22% | 0,80 | **-5,38%** | 0,00% | -36,83% | 94,69% | -58,48% | 71,34% | **0** |
| **`BALANCED_75WR`** (`1.0x`) | **Full 5Y (61m)** | 1.710 | **75,79%** | **1,29** | **+8,42%** | 14,75% | -36,83% | 94,69% | +5.264,32% | 71,34% | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | Cal+Val (49m) | 1.381 | 77,48% | 1,44 | **+25,41%** | 44,90% | -36,72% | 66,40% | +468.172,10% | 65,13% | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | **Blind Y5 (13m)** | 320 | 68,13% | 0,80 | **-8,61%** | 7,69% | **-61,09%** | 170,78% | -84,45% | **92,84%** | **0** |
| **`TARGET_30MO_75WR`** (`2.0x`) | **Full 5Y (61m)** | 1.705 | **75,72%** | **1,29** | **+18,42%** | 37,70% | **-61,09%** | 170,78% | +69.033,01% | **92,84%** | **0** |

---

## 4. Hiệu Suất Từng Luồng Đơn Lẻ (8 Luồng Crypto 5Y & Futures 2Y `1h`)

### 4.1. 8 Luồng Crypto v7.0 (`EXCHANGE_POST_ONLY` & `STRICT_TAKER`, `liquidationCount = 0` trên mọi luồng)

| Luồng (`Stream`) | Cal+Val Screening | Post-Only `Cal` (WR / PF) | Post-Only `Val` (WR / PF) | Post-Only **Blind Y5** (n / WR / PF / Comp) | Post-Only **Full 5Y** (n / WR / PF / Mo / Comp / DD) | Strict Taker **Blind Y5** (WR / PF / Comp) | Gate Y5 |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- | :---: |
| **`BTC_1h`** (`LR`) | ✅ Keep | 70,30% / 1,17 | 79,65% / 1,68 | 68 / **75,00% / 1,38 / +30,52%** | 347 / 74,06% / 1,32 / +2,29% / +226,78% / 44,01% | 75,00% / 1,29 / +22,33% | **PASS (`true`)** |
| **`BTC_15m`** (`GB`) | ✅ Keep | 80,23% / 1,34 | 79,24% / 1,28 | 144 / 77,08% / 0,96 / -6,97% | 729 / **79,29%** / 1,24 / +1,91% / +168,21% / 31,11% | 75,52% / 0,82 / -21,65% | FAIL (`false`) |
| **`BNB_1h`** (`GB`) | ❌ Excluded | 71,33% / 1,36 | 77,11% / 1,87 | 59 / 66,10% / 0,94 / -7,90% | 286 / 71,68% / 1,36 / +2,06% / +200,14% / 29,65% | 66,67% / 0,94 / -7,35% | FAIL (`false`) |
| **`BNB_15m`** (`LR`) | ❌ Excluded | 78,05% / 1,02 | 81,03% / 1,06 | 35 / 65,71% / 0,45 / -19,61% | 175 / 76,57% / 0,86 / -0,29% / -18,89% / 31,32% | 61,76% / 0,38 / -23,81% | FAIL (`false`) |
| **`SOL_15m`** (`LR`) | ✅ Keep | 76,65% / 1,52 | 77,17% / 1,62 | 66 / 63,64% / 0,82 / -15,98% | 390 / 74,62% / 1,40 / +2,57% / +297,36% / 27,66% | 62,12% / 0,71 / -24,93% | FAIL (`false`) |
| **`SOL_1h`** (`GB`) | ✅ Keep | 80,28% / 2,66 | 76,00% / 2,02 | 34 / 67,65% / 1,16 / +5,63% | 156 / **76,28% / 2,00** / +2,50% / **+321,90%** / **16,80%** | 64,71% / 0,96 / -3,46% | FAIL (`false`) |
| **`ETH_15m`** (`GB`) | ✅ Keep | 86,76% / 3,04 | 77,97% / 1,34 | 28 / 50,00% / 0,61 / -18,20% | 155 / **76,77%** / 1,47 / +1,05% / +79,45% / 25,71% | 51,72% / 0,56 / -20,32% | FAIL (`false`) |
| **`ETH_1h`** (`LR`) | ✅ Keep | 75,37% / 1,58 | 74,42% / 1,59 | 49 / 67,35% / 0,95 / -5,71% | 270 / 73,33% / 1,43 / +2,26% / +240,26% / 24,61% | 67,35% / 0,91 / -8,22% | FAIL (`false`) |

> **Nhận xét trung thực về từng luồng đơn lẻ:** Mặc dù bộ `Two-Stage Maker Exit + ML` giúp 5/8 luồng duy trì WR `75%–80%` trên `Cal+Val`, ở năm Y5 khắc nghiệt chỉ có **`BTC_1h`** vượt trọn vẹn Gate Y5 độc lập trên cả `EXCHANGE_POST_ONLY` (`+30,52%`, WR `75,00%`, PF `1.38`) và `STRICT_TAKER` (`+22,33%`, WR `75,00%`, PF `1.29`). `SOL_1h` giữ được lãi dương ở Y5 Post-Only (`+5,63%`, `PF 1.16`, DD `12,01%`) nhưng WR Y5 đạt `67,65%` (< ngưỡng 72%) và âm nhẹ ở Taker (`-3,46%`).

### 4.2. Helper Sleeve Chứng Khoán Futures `1h` 2 Năm OOS (`2024-07-07` – `2026-11-25`)

| Hợp đồng (`1h` + `1d` HTF) | Số lệnh | Win Rate | PF | Ghép lãi (%) | CAGR | Max DD | Sharpe | Calmar | Liq |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`ES=F`** (E-Mini S&P 500) | 45 | **80,00%** | 1,96 | +23,21% | 9,15% | 5,95% | 1,15 | 1,54 | **0** |
| **`NQ=F`** (E-Mini Nasdaq) | 42 | 73,81% | 1,80 | +21,60% | 8,55% | 7,75% | 0,92 | 1,10 | **0** |
| **Combined `ES=F + NQ=F`** | **87** | **77,01%** | **1,88** | **+50,07%** | **18,57%** | **12,30%** | **1,46** | **1,51** | **0** |

---

## 5. Kết Quả Kiểm Định Độc Lập (`tests/verify_v7_75wr_30mo.mjs`)

- **Suite 1 (Nhân quả Cắt tiền tố & Đột biến tương lai 5Y `15m` + `1h`):** `BTC_1h`, `BTC_15m`, `BNB_1h`, `BNB_15m`, `SOL_15m`, `SOL_1h`, `ETH_15m`, `ETH_1h` đều cho kết quả bất biến **100%** khi cắt tiền tố và đột biến OHLCV / `takerBuyVol` / HTF / `fundingRows` tương lai (`barIndex`, `atr`, `limitPrice`, đặc trưng `< 1e-12`, ML scores và lệnh đóng trước mốc cắt `T`).
- **Suite 2 (Vật lý Thanh lý & Zero-Liq Frontier):** Kiểm chứng trực tiếp râu nến xấu gây **`LIQUIDATION` (`-100%`, `equity=0`)** trước TP cả trên vị thế đơn lẫn cross-margin đa luồng; xác minh cả 3 tier v7 đều có `liquidationCount === 0` và `sweepLiquidationCount === 0` trên đủ 61 tháng UTC.
- **Suite 3 (Zero-Leakage Y5 & Parity `< 1e-12` Python `sklearn` vs JS):** Ranh giới `Cal/Val/Holdout` tách biệt tuyệt đối cho cả 8 mô hình (`1h`: `[0..21.976..35.161..43.952]`; `15m`: `[0..87.904..140.646..175.808]`); độ lệch `predict_proba` giữa Python `scikit-learn` và Pure-JS `< 1e-12` (0 sai lệch quyết định trên >= 60 mẫu thực/mô hình).
- **Suite 4 (Bảo mật Standalone v7):** Không có `innerHTML` / `eval` / inline script trong `standalone/public/`; `.env.example` khóa mặc định `EXECUTION_MODE=PAPER`, `DRY_RUN=true`, `RISK_TIER=SAFE_75WR`; ràng buộc loopback `127.0.0.1`; endpoint `/api/status`, `/api/frontier`, `/api/backtest?version=v7` và khóa token `POST /api/mode` hoạt động chính xác.

---

## 6. Hướng Dẫn Vận Hành v7.0 Qua CLI & WebUI

```bash
# Kiểm tra hệ thống, SQLite WAL, mô hình v7 & kết nối public
node standalone/cli.mjs doctor

# Xem bảng 3 Risk Tiers & Monthly Profit-Sweep 61 tháng
node standalone/cli.mjs portfolio --tier SAFE_75WR --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs portfolio --tier BALANCED_75WR --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs portfolio --tier TARGET_30MO_75WR --profile EXCHANGE_POST_ONLY

# Chạy backtest đơn luồng v7
node standalone/cli.mjs backtest --version v7 --symbol BTCUSDT.P --timeframe 1h --tier SAFE_75WR

# Mở Command Center cục bộ (http://127.0.0.1:4180) với nút chuyển Tier, Monthly Sweep Gauge & Distance-to-Liq Card
node standalone/cli.mjs serve
```
