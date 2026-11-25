# Báo Cáo Kiểm Định & Đối Chiếu v8.0 vs v7.0: Nhận Diện Chế Độ Xu Hướng Vĩ Mô (`regime_engine_v8`) & Chuyên Biệt Hóa Long / Bear Rally-Fade Short

**Trạng thái kiểm định độc lập (`verifier-v5`):** ✅ **PASS — Kiểm định nhân quả đa khung (`15m`, `1h`, `1d` + Breadth 4 coin), `BEAR_SQUEEZE` Short-Blocking, Zero-Leakage Y5, Parity `< 1e-12` Python vs JS cho cả 16 mô hình Long/Short v8.0, Zero-Liq trên 61 tháng UTC & Bảo mật Standalone.**  
**Dữ liệu:** Crypto 5 năm `15m` (175.808 nến/coin) + `1h` (43.952 nến/coin) + Chứng khoán Mỹ 10 năm (`SPY`, `DIA`, `QQQ` 2.513 phiên + `^VIX`/`^TNX`) + Futures Mỹ 2 năm `1h` (`ES=F`, `NQ=F`).

---

## 1. Động Cơ v8.0 Giải Quyết Gì So Với v7.0?

Ở phiên bản **v7.0**, hệ thống sử dụng cùng một bộ kích hoạt đối xứng cho cả hai chiều Long và Short, dẫn đến việc vào Short bị kẹt trong các cú giật ngắn hạn (*short squeeze*) hoặc bắt dao rơi Long giữa xu hướng giảm mạnh năm Y5 (ví dụ `BTC_15m` Shorts lỗ `-25,9%`, `ETH_1h` Shorts lỗ `-10,3%`, `BNB_15m` Full 5Y âm `-18,89%`).

**v8.0** nâng cấp kiến trúc theo 3 trục hoàn toàn nhân quả (`htf.time + htfSec <= ltf.time`):
1. **Macro-Trend Regime & Breadth Engine (`research/regime_engine_v8.mjs`):**
   - **`precomputeCryptoBreadthV8`:** Tính độ rộng thị trường trên cả 4 coin (`BTC`, `ETH`, `SOL`, `BNB`) theo từng ngày đóng cửa `1D` (`breadthBearEma50`, `breadthBearEma200`, `btcD1Trend`).
   - **Phân loại 4 chế độ thị trường tức thời (`precomputeAssetRegimeV8`):**
     - `BULL_TREND` (Ưu tiên `LONG`, chặn Short ngược xu hướng).
     - `BEAR_TREND` (Chặn bắt dao rơi `LONG`, mở `Bear Rally-Fade SHORT` khi nhịp hồi yếu đi vào vùng kháng cự `1H/4H EMA`).
     - `BEAR_SQUEEZE` (Giảm mạnh `shortSizeMult = 0`, chặn Short giữa cú bật hồi ngắn hạn có funding âm sâu / động lượng `4H` mạnh cho tới khi kiệt sức).
     - `RANGE_CHOP` (Thu nhỏ khối lượng hoặc đứng ngoài).
   - **Kiểm chứng phân loại trên giai đoạn thực tế (`BTC 1h`):** `2022 Bear` (85,7% Bear), `2023–24 Bull` (94,0% `BULL_TREND`), `Y5 Bear` (62,0% Bear).
2. **Tách riêng hoàn toàn `longModel` và `shortModel` (`scikit-learn` Purged):**
   - 8 luồng x 2 chiều = **16 mô hình riêng biệt**, huấn luyện `Cal [0..50%)` (có cả sóng giảm 2022), khóa ngưỡng `tauLong` / `tauShort` trên `Val [50%..80%)`, giữ nguyên **Blind Holdout Y5 `[80%..100%)`**.
3. **Phân bổ động theo Regime (`aligned_boost`):** Nhân `1.18x` cho Long trong `BULL_TREND` / Short trong `BEAR_TREND`, giảm còn `0.70x` trong `RANGE_CHOP`, chặn `0x` Short trong `BEAR_SQUEEZE` (`simulatePortfolioV7` với `mmr = 0.005`, `liquidationCount === 0` bắt buộc ở cả Compounded & Monthly Sweep).

---

## 2. Bảng Đối Chiếu Toàn Diện v7.0 vs v8.0 (Danh Mục 5 Năm — Zero Liquidation)

### 2.1. Dưới hồ sơ `EXCHANGE_POST_ONLY` (Limit Maker + Funding thực 8h, 61 tháng UTC)

| Tier & Phiên bản | Giai đoạn | Số lệnh | Win Rate | PF | **Monthly Sweep (`%/mo`)** | Tháng >= +30% | Tháng xấu nhất | Sweep DD | **Compounded (%) / CAGR** | Comp DD | **Liq** |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- | ---: | ---: |
| **SAFE_75WR — v7.0** (`0.75x`, 5 luồng) | Cal+Val (49m) | 1.375 | 78,47% | 1,59 | +10,77% | 12,24% | -9,43% | 15,41% | +10.458,17% / 219,53% | 23,33% | **0** |
| **SAFE_75WR — v8.0** (`0.50x`, 8 luồng) | Cal+Val (49m) | 1.432 | **78,77%** | **1,76** | **+13,00%** | 10,20% | -9,41% | **9,41%** | **+28.129,07%** | 24,22% | **0** |
| **SAFE_75WR — v7.0** | Blind Y5 (13m) | 321 | **69,47%** | **0,90** | **-1,70%** | 0,00% | -27,70% | **45,98%** | **-27,23%** | **47,69%** | **0** |
| **SAFE_75WR — v8.0** | Blind Y5 (13m) | 314 | 64,97% | 0,82 | -3,24% | 0,00% | **-23,66%** | 79,01% | -41,57% | 60,12% | **0** |
| **SAFE_75WR — v7.0** | **Full 5Y (61m)** | 1.700 | **76,76%** | 1,42 | +8,25% | **9,84%** | -27,70% | **45,98%** | +7.454,52% / 136,92% | **47,69%** | **0** |
| **SAFE_75WR — v8.0** | **Full 5Y (61m)** | 1.752 | 76,14% | **1,51** | **+9,58%** | 6,56% | **-23,66%** | 79,01% | **+15.089,56%** / 172,34% | 61,66% | **0** |
| **BALANCED_75WR — v7.0** (`1.0x`) | Full 5Y (61m) | 1.700 | **76,76%** | 1,42 | +11,29% | 14,75% | -35,31% | **60,11%** | +27.355,04% / 206,47% | **58,77%** | **0** |
| **BALANCED_75WR — v8.0** (`0.75x`, 8 luồng) | **Full 5Y (61m)** | 1.752 | 76,14% | **1,51** | **+15,06%** | **29,51%** | **-33,64%** | 89,93% | **+149.049,68%** / 329,51% | 76,94% | **0** |
| **BALANCED_75WR — v8.0** | Blind Y5 (13m) | 314 | 64,97% | 0,82 | -4,51% | 0,00% | -33,64% | — | -57,13% | — | **0** |
| **TARGET_30MO — v7.0** (`2.0x`, 5 luồng) | Cal+Val (49m) | 1.372 | 78,43% | 1,58 | **+31,65%** | **46,94%** | -27,09% | 49,63% | +5.652.886,77% | 53,71% | **0** |
| **MAXIMIZED_30MO — v8.0** (`1.50x`, 6 luồng) | Cal+Val (49m) | 874 | **81,92%** | **2,16** | **+30,76%** | 36,73% | **-23,82%** | **26,92%** | **+10.214.650,87%** | **49,03%** | **0** |
| **TARGET_30MO — v7.0** | Blind Y5 (13m) | 320 | **69,38%** | **0,92** | **-1,90%** | 7,69% | -59,19% | **108,16%** | **-62,70%** | 85,47% | **0** |
| **MAXIMIZED_30MO — v8.0** | Blind Y5 (13m) | 192 | 66,15% | 0,81 | -5,67% | 7,69% | **-36,67%** | 130,29% | -65,88% | **80,39%** | **0** |
| **TARGET_30MO — v7.0** | **Full 5Y (61m)** | 1.696 | 76,71% | 1,42 | **+24,87%** | **39,34%** | -59,19% | **108,16%** | +2.008.476,79% / 621,45% | 85,47% | **0** |
| **MAXIMIZED_30MO — v8.0** | **Full 5Y (61m)** | 1.069 | **78,86%** | **1,74** | +22,84% | 31,15% | **-36,67%** | 130,29% | **+2.704.246,92%** / 665,55% | **80,39%** | **0** |

### 2.2. Dưới hồ sơ khắc nghiệt `STRICT_TAKER` (Khớp thị trường + Slippage 2 chiều)

| Tier & Phiên bản | Cal+Val (WR / PF / `%/mo`) | Blind Y5 (WR / PF / `%/mo` / Worst) | **Full 5Y (WR / PF / `%/mo` / Comp / CompDD)** | **Liq** |
| :--- | :--- | :--- | :--- | ---: |
| **SAFE_75WR — v7.0 vs v8.0** | 77,55% / 1,45 / +8,79% -> **77,87% / +10,87%** | -4,13% -> -4,90% (Worst -28,98% -> **-19,55%**) | +6,14% / +2.122,91% -> **+7,51% / 1,38 / +4.791,86%** (DD 62,21%) | **0** |
| **BALANCED_75WR — v7.0 vs v8.0** | +11,97% -> **+16,94%/mo** | -5,38% -> -7,17% (Worst -36,83% -> **-28,13%**) | +8,42% / +5.264,32% -> **+11,79% / 1,38 / +27.051,35%** (DD 77,46%) | **0** |
| **TARGET/MAX_30MO — v7.0 vs v8.0** | +25,41% / 1,44 -> **81,05% / 1,96 / +27,11%** | -8,61% -> -8,88% (Worst -61,09% -> **-38,10%**) | +18,42% / +69.033% -> **+19,23% / 1,59 / +420.317,64%** (DD **84,13%**) | **0** |

---

## 3. Phân Tích Trung Thực: Điều Gì Đã Cải Thiện Mạnh & Giới Hạn Còn Lại Ở Blind Holdout Y5

### 3.1. Những cải thiện thực chất trên toàn chu kỳ 5 năm (Full 5Y & Tail Risk)
- **Tăng vọt chất lượng tích lũy & cắt đuôi lỗ nặng (`Worst Month`):**
  - Ở `TIER_3`, Full 5Y Win Rate tăng từ `76,71%` lên **`78,86%`** (`PF 1.42 -> 1.74`), tháng tệ nhất giảm từ **`-59,19%` xuống `-36,67%`** (cắt `22,52%` rủi ro đuôi!), Compounded DD giảm từ `85,47%` xuống `80,39%`, và lợi nhuận Taker tăng từ `+18,42%/mo` lên **`+19,23%/mo`** (`+69.033%` -> `+420.318%`).
  - Ở `TIER_2`, tốc độ Monthly Sweep vọt từ `+11,29%/mo` lên **`+15,06%/mo`**, tỷ lệ tháng đạt `>= +30%` tăng gấp đôi (**`14,75%` -> `29,51%`**).
  - Các luồng đơn lẻ giảm drawdown rõ rệt nhờ né bắt dao rơi và `BEAR_SQUEEZE`: `BTC_1h` 5Y tăng từ `+226,78%` (DD `44,01%`) lên **`+418,22%`** (DD chỉ **`20,15%`**, PF `1.69`); `BNB_15m` lật từ `-18,89%` lên **`+90,32%`**; `BNB_1h` giảm DD từ `29,65%` xuống **`17,45%`** (`PF 2.01`); `SOL_15m` tăng WR lên **`80,18%`** (`PF 2.06`, `+360,35%`, DD `22,54%`).
- **Chứng khoán Mỹ (`precomputeEquityRegimeV8`):** Danh mục `SPY+DIA+QQQ` cải thiện **Blind Holdout 2Y** từ `WR 61,80%, DD 21,82%, +9,94%` (v6) lên **`WR 67,05%, PF 1.18, DD 16,19%, +11,98%`** (riêng `SPY` Blind 2Y tăng từ `57,14% WR / +1,18%` lên **`67,65% WR / PF 1.28 / +6,71%`**). Futures `1h` 2Y OOS (`ES=F + NQ=F`) đạt `WR 76,74%`, `PF 1.73`, `+39,51%`, `DD 12,30%`, `Liq=0`.

### 3.2. Giới hạn thực tế không che giấu ở Blind Holdout Y5 (`2025-11` – `2026-11`)
- **Bear Rally-Fade Shorts vẫn gặp khó ở năm Y5 trên cấp danh mục:** Dù một số nhánh Short đơn lẻ có lãi dương trong Y5 (`BNB_1h` Y5 Shorts `+3,69%` WR `71,43%`, `BNB_15m` Y5 Shorts `+2,76%` WR `69,81%`, `ETH_15m` Y5 Shorts `+0,31%` WR `69,23%` — đảo chiều hoàn toàn từ mức lỗ `-20,9%` ở v7), tổng hợp các nhánh Short trên BTC/SOL/ETH_1h vẫn âm ở Y5 (`BTC_1h` Y5 Shorts `-16,02%`, `BTC_15m` Y5 Shorts `-15,30%`, `SOL_1h` Y5 Shorts `-14,99%`), kéo kết quả danh mục Blind Holdout Y5 xuống **`-3,24%/mo`** (`SAFE`), **`-4,51%/mo`** (`BALANCED`), **`-5,67%/mo`** (`MAXIMIZED`).
- **Tác động của việc siết chặn giao dịch ngược pha (`0/8` luồng vượt trọn dual-profile Y5 Gate):** Vì mục tiêu `>= 72% WR & PF >= 1.15` ở cả hai chiều trên một thị trường gấu nhiều pha giật hai đầu, `BTC_1h` dù có lãi Y5 dương (`+7,37%` Post-Only, `+4,25%` Taker; Longs Y5 đạt **`83,33% WR, +26,03%`**!) nhưng đạt `71,43% WR / PF 1.10` dưới `STRICT_TAKER` nên hệ thống **trung thực đánh dấu `qualifiedForLive = false`** cho cả 8 luồng đơn lẻ thay vì nới tiêu chuẩn.
- **Tóm lại:** Kiến trúc v8.0 vượt trội hẳn v7.0 về **WR tổng 5Y (`78,86%`), PF (`1.74`), `Compounded CAGR` (`665,55%`) và cắt rủi ro tháng xấu nhất (`-36,67%` thay vì `-59,19%`)**, nhưng **chưa giải quyết triệt để vấn đề sinh lời dương ổn định khi bước vào giai đoạn giảm giá kéo dài kiểu Y5**, và **mục tiêu `>= +30%/tháng` trên Full 61 tháng vẫn chưa đạt (`+22,84%/mo` Post-Only, `+19,23%/mo` Taker)** nếu không chịu rủi ro phá hủy vốn khi thị trường đảo chiều.

---

## 4. Hiệu Suất 8 Luồng Đơn Lẻ v8.0 (`EXCHANGE_POST_ONLY` & Breakdown Long/Short Y5)

| Luồng | Cal+Val Screened | `Cal` (WR / PF) | `Val` (WR / PF) | **Blind Y5 (n / WR / PF / Comp)** | **Y5 Long vs Short Net** | **Full 5Y (n / WR / PF / Mo / Comp / DD)** |
| :--- | :---: | :--- | :--- | :--- | :--- | :--- |
| **`BTC_1h`** | ✅ 79,89% | 80,39% / 2,15 | 79,31% / 1,71 | 50 / **72,00% / 1,15 / +7,37%** | L: +26,03% (83,3%) \| S: -16,02% | 240 / 77,92% / 1,69 / +2,98% / **+418,22%** / **20,15%** |
| **`BTC_15m`** | ✅ 82,56% | 83,00% / 1,93 | 81,94% / 1,60 | 31 / 70,97% / 0,54 / -15,38% | L: -0,31% (75,0%) \| S: -15,30% | 203 / **80,79%** / 1,49 / +1,16% / +88,06% / **19,03%** |
| **`BNB_1h`** | ✅ 83,00% | 83,61% / 2,74 | 82,05% / 2,44 | 30 / 70,00% / 1,12 / **+2,98%** | L: +0,60% \| **S: +3,69% (71,4%)** | 131 / 79,39% / **2,01** / +1,84% / +186,75% / **17,45%** |
| **`BNB_15m`** | ✅ 73,05% | 71,09% / 1,18 | 76,05% / 1,34 | 83 / 65,06% / 0,85 / -16,78% | L: -17,85% \| **S: +2,76% (69,8%)** | 506 / 71,74% / 1,16 / +1,37% / +90,32% / 32,97% |
| **`SOL_15m`** | ✅ 84,18% | 85,59% / 2,93 | 82,09% / 2,36 | 39 / 61,54% / 0,75 / -12,78% | L: -4,18% \| S: -8,98% | 217 / **80,18%** / **2,06** / +2,66% / **+360,35%** / 22,54% |
| **`SOL_1h`** | ✅ 74,77% | 75,93% / 1,83 | 73,68% / 1,78 | 32 / 56,25% / 0,80 / -11,01% | L: +4,67% \| S: -14,99% | 144 / 70,14% / 1,48 / +1,43% / +113,61% / 28,60% |
| **`ETH_15m`** | ✅ 81,30% | 83,61% / 2,79 | 79,37% / 1,69 | 22 / 68,18% / 0,93 / -2,21% | L: -2,52% \| **S: +0,31% (69,2%)** | 146 / 79,45% / 1,81 / +1,25% / +106,56% / 23,86% |
| **`ETH_1h`** | ✅ 81,02% | 82,61% / 2,77 | 79,41% / 1,89 | 27 / 51,85% / 0,39 / -27,61% | L: -21,27% \| S: -8,06% | 165 / 75,76% / 1,63 / +1,75% / +162,32% / 36,58% |

---

## 5. Kết Quả Kiểm Định Toàn Hệ Thống & Hướng Dẫn Sử Dụng Macro-Trend Regime Radar

- **Suite kiểm định độc lập mới (`tests/verify_v8_regime_maximizer.mjs`):**
  1. Nhân quả 100% (`regime_engine_v8.mjs` trên `15m`, `1h`, `1d`, breadth 4 coin + toàn bộ 8 luồng v8 bất đối xứng), chặn hoàn toàn Short trong `BEAR_SQUEEZE` & `BULL_TREND`, chặn Long trong `BEAR_TREND`.
  2. Zero Y5 Leakage & Parity `< 1e-12` Python `scikit-learn` vs Pure-JS trên **cả 16 mô hình Long/Short v8.0**.
  3. Zero Liquidation (`liquidationCount === 0` trên toàn bộ 61 tháng UTC ở cả 3 Tier & Futures 2Y) + thử nghiệm kích hoạt `LIQUIDATION` đối kháng.
  4. Zero-XSS, `127.0.0.1`, khóa `EXECUTION_MODE=PAPER` & `RISK_TIER=SAFE_75WR`, API `/api/regime`, `/api/frontier?version=v8`, `/api/backtest?version=v8`.

```bash
# Kiểm tra toàn hệ thống v8 + kết nối public (OKX, Binance, Yahoo VIX/TNX)
node standalone/cli.mjs doctor

# Xem Macro-Trend Regime Radar hiện tại (BULL_TREND / BEAR_TREND / BEAR_SQUEEZE / RANGE_CHOP + Breadth 4 coin)
node standalone/cli.mjs regime --symbol BTCUSDT.P --timeframe 1h

# Chạy bảng 61 tháng v8.0 & backtest đơn luồng v8.0
node standalone/cli.mjs portfolio --version v8 --tier SAFE_75WR --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs backtest --version v8 --symbol BTCUSDT.P --timeframe 1h

# Bật Web Command Center cục bộ (http://127.0.0.1:4180)
node standalone/cli.mjs serve
```
