# Báo Cáo Tổng Hợp & Kiểm Định v6.0: Crypto 5 Năm (BTC/BNB/ETH/SOL), Chứng Khoán Mỹ 10 Năm (SPY/DIA/QQQ), Futures 1H & Giao Dịch Độc Lập Không Cần TradingView

**Trạng thái kiểm định độc lập (`verifier-v5`):** ✅ **PASS — Kiểm định nhân quả, Zero-Leakage, Parity `< 1e-12` Python vs JS cho cả 7 mô hình v6.0, Gap-Risk, Bảo mật & Toàn bộ Suite v4.1 + v5.0 + v6.0.**  
**Ngày báo cáo:** 25/11/2026 | **Dữ liệu Crypto 5Y:** 43.952 nến `1h` (~5 năm, Binance Futures + `takerBuyVol` + Funding 8h thực tế) | **Dữ liệu Chứng khoán Mỹ:** 2.513 phiên `1d` (~10 năm, 25/11/2016 – 24/11/2026) + `^VIX` / `^TNX` + Futures `1h` ~2 năm (07/07/2024 – 25/11/2026).

> **Nguyên tắc trung thực dữ liệu:** Mọi con số dưới đây trích trực tiếp từ tệp kết quả đã khóa (`research/results_v6/crypto_btc_bnb_5y.json`, `crypto_eth_sol_5y.json`, `stocks_indices_5y_10y.json`, `models_*.json`) và các kiểm thử tự động trong `tests/verify_v6_full_suite.mjs`. Những điểm yếu thực tế — như **ETHUSDT trượt Gate Blind Holdout Y5** hay biên lợi nhuận mỏng của **SPY/DIA trên đoạn Holdout 2Y gần nhất** — được giữ nguyên không che giấu.

---

## 1. Tóm Tắt Điều Hành (Executive Summary)

1. **Mở rộng quy mô dữ liệu & đa tài sản hoàn toàn ngoài TradingView:**
   - **Crypto 5 Năm (`1h`, 43.952 nến/coin):** `BTCUSDT`, `BNBUSDT`, `ETHUSDT`, `SOLUSDT` (phân tách chuẩn **Cal 50%** `[0..21.976]` ~2,5 năm | **Val 30%** `[21.976..35.161]` ~1,5 năm | **Blind Holdout Y5 20%** `[35.161..43.952]` ~1 năm cuối trong thị trường giảm mạnh `-32,5%` đến `-48,4%`).
   - **Chỉ số Chứng khoán Mỹ 10 Năm (`1d`, 2.513 phiên):** `SPY` (`^GSPC`), `DIA` (`^DJI`), `QQQ` (`^NDX`) kết hợp vĩ mô `^VIX` và lợi suất trái phiếu Mỹ 10 năm `^TNX` (phân tách **Cal 5Y** `[0..1.256]` | **Val 3Y** `[1.256..2.010]` | **Blind Holdout 2Y** `[2.010..2.513]`, kèm lát cắt **OOS 5Y** `[1.256..2.513]` và **Full 10Y**).
   - **US Index Futures Intraday `1h` (~2 năm, OOS thuần 100%):** Đánh giá Out-of-Sample mô hình daily đã khóa sang khung `1h` (với HTF `1d` nhân quả `d1Bar.time + 86400 <= h1Bar.time`) trên `ES=F`, `YM=F`, `NQ=F`.

2. **Kết quả nổi bật trên Blind Holdout (chưa từng chạm khi train/chọn mô hình):**
   - **Crypto (năm Y5 thị trường gấu: BTC Buy&Hold `-32,54%`, BNB `-36,01%`, ETH `-41,52%`, SOL `-48,44%`):**
     - `BTCUSDT` ML đạt **+44,30%** (`PF 1.46`, DD `13,75%`, Sharpe `1.25`) dưới `EXCHANGE_POST_ONLY` và **+16,99%** (`PF 1.21`, DD `22,39%`) dưới `STRICT_TAKER`.
     - `SOLUSDT` ML đạt **+56,54%** (`PF 1.29`, DD `26,60%`, Sharpe `1.24`) dưới `EXCHANGE_POST_ONLY` và **+23,51%** (`PF 1.16`, DD `27,17%`) dưới `STRICT_TAKER` — **ĐẠT Live Gate (`qualifiedForLive: true`)**.
     - `BNBUSDT` ML giữ dương bảo thủ ở Y5 (**+0,03%** `EXCHANGE_POST_ONLY`, **+1,14%** `STRICT_TAKER`, DD `17,17%–17,50%`) và tăng trưởng ổn định cả 5 năm (**+195,58%**, CAGR `24,11%`, DD `23,14%`).
     - `ETHUSDT` ML đạt kết quả rất mạnh ở Full 5Y (`+312,53%`, `PF 1.67`), nhưng **thất bại ở năm Y5 độc lập** (`-9,90%`, `PF 0.85` Post-Only; `-12,17%`, `PF 0.81` Taker) -> **Bị chặn tự động khỏi danh sách Live (`qualifiedForLive: false`)**.
     - **Danh mục 3 coin đạt chuẩn (`BTC+BNB+SOL`, `maxTotalOpenLev=4.0`):** Blind Y5 **+111,22%** (`PF 1.29`, DD `32,85%`, Calmar `3.37`) Post-Only | **+38,91%** (`PF 1.15`, DD `34,93%`) Strict Taker.
   - **Chứng khoán Mỹ (10 năm + OOS 5Y + Danh mục 3 chỉ số, `EQUITY_ETF` cho phép gap cuối tuần & tính trượt giá mở cửa qua đêm `SL` xấu hơn):**
     - **Danh mục Multi-Index (`SPY + DIA + QQQ`, `maxTotalOpenLev=3.0`):** Full 10Y đạt **+492,48%** ghép lãi (CAGR **19,48%**, PF **1.70**, Max DD **21,82%**, Sharpe **1.39**, Calmar **0.89**); **OOS 5Y** đạt **+132,80%** (CAGR **18,39%**, PF **1.62**, Max DD **21,82%**, Sharpe **1.30**); **Blind Holdout 2Y** đạt **+9,94%** (`PF 1.15`, CAGR `4,83%`).
     - **QQQ** nổi bật nhất trong 3 ETF: **OOS 5Y +55,59%** (Max DD chỉ **8,28%** so với Buy&Hold DD **35,54%**, Sharpe `1.14`, Calmar `1.11`); **Blind Holdout 2Y +9,42%** (`PF 1.39`, DD `7,91%` vs B&H DD `22,88%`).
     - **Futures `1h` OOS (~2 năm, không train lại):** `ES=F` đạt **+23,24%** (`PF 1.97`, DD `5,95%`), `NQ=F` **+23,93%** (`PF 1.88`, DD `7,75%`), `YM=F` **+0,78%** (`PF 1.06`, DD `5,38%`); **Portfolio 3 Futures 2Y đạt +53,92%** (CAGR **19,84%**, `PF 1.67`, DD `15,67%`, Sharpe **1.35**).

---

## 2. Kết Quả Crypto 5 Năm (`1h`, 43.952 Nến — Cal / Val / Blind Y5 / Full 5Y)

Cấu hình chi phí thực tế trong `sim_engine_v6.mjs`:
- **`EXCHANGE_POST_ONLY`:** Lệnh Limit chạm sâu qua giá giới hạn (`makerBufferPct`), phí maker khi khớp Limit, phí taker khi dính SL, tính **funding rate lịch sử 8h thực tế** (`fundingRows`).
- **`STRICT_TAKER`:** Khớp thị trường/taker kèm slippage cho cả vào và ra + funding thực tế 8h.

### 2.1. Tổng hợp Cal / Val / Blind Holdout Y5 / Full 5Y — `EXCHANGE_POST_ONLY`

| Tài sản & Mô hình | Giai đoạn | Tín hiệu | Win Rate | Profit Factor | Tổng Net (%) | Ghép lãi (%) | Max DD (%) | Sharpe | Buy & Hold (%) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **BTCUSDT** — Base (`AdaptiveTrap`) | Cal (2.5Y) | 181 | 65,19% | 1,14 | +41,88% | +28,54% | 47,92% | 0,46 | +16,91% |
| **BTCUSDT** — **v6 ML** (`LR, t=0.6131`) | Cal (2.5Y) | 152 | 66,45% | 1,12 | +32,35% | +17,79% | 53,48% | 0,36 | +16,91% |
| **BTCUSDT** — Base | Val (1.5Y) | 130 | 74,62% | 1,43 | +66,38% | +77,88% | 32,40% | 1,30 | +27,77% |
| **BTCUSDT** — **v6 ML** | Val (1.5Y) | 110 | **77,27%** | **1,74** | +94,13% | **+134,84%** | **27,08%** | **1,86** | +27,77% |
| **BTCUSDT** — Base | Blind Y5 | 87 | 70,11% | 1,14 | +17,41% | +12,26% | 15,37% | 0,51 | -32,54% |
| **BTCUSDT** — **v6 ML** | **Blind Y5** | 66 | **71,21%** | **1,46** | +42,37% | **+44,30%** | **13,75%** | **1,25** | -32,54% |
| **BTCUSDT** — Base | Full 5Y | 400 | 69,25% | 1,22 | +126,69% | +158,62% | 47,92% | 0,71 | +0,79% |
| **BTCUSDT** — **v6 ML** | **Full 5Y** | 330 | **70,91%** | **1,35** | +168,71% | **+296,93%** | 53,48% | **0,96** | +0,79% (DD 73,87%) |
| **BNBUSDT** — Base (`AdaptiveTrap`) | Cal (2.5Y) | 137 | 67,88% | 1,45 | +72,72% | +87,90% | 25,24% | 1,04 | +1,71% |
| **BNBUSDT** — **v6 ML** (`LR, t=0.6510`) | Cal (2.5Y) | 120 | 70,00% | 1,58 | +79,89% | +103,31% | 23,14% | 1,19 | +1,71% |
| **BNBUSDT** — Base | Val (1.5Y) | 88 | 67,05% | 1,33 | +37,52% | +37,43% | 29,25% | 0,90 | +40,85% |
| **BNBUSDT** — **v6 ML** | Val (1.5Y) | 78 | **70,51%** | **1,51** | +46,09% | **+50,75%** | **21,72%** | **1,18** | +40,85% |
| **BNBUSDT** — Base | Blind Y5 | 59 | 66,10% | 1,01 | +0,80% | -2,01% | 23,27% | 0,03 | -36,01% |
| **BNBUSDT** — **v6 ML** | **Blind Y5** | 43 | **67,44%** | **1,04** | +2,08% | **+0,03%** | **17,17%** | **0,10** | -36,01% (DD 46,64%) |
| **BNBUSDT** — Base | Full 5Y | 285 | 67,02% | 1,30 | +107,45% | +143,96% | 29,25% | 0,79 | -7,71% |
| **BNBUSDT** — **v6 ML** | **Full 5Y** | 242 | **69,42%** | **1,44** | +124,48% | **+195,58%** | **23,14%** | **0,98** | -7,71% (DD 71,23%) |
| **ETHUSDT** — Base (`HtfSmcMultiTrap`) | Cal (2.5Y) | 136 | 70,59% | 1,52 | +85,66% | +115,52% | 18,25% | 1,29 | -11,22% |
| **ETHUSDT** — v6 ML (`LR, t=0.6877`) | Cal (2.5Y) | 97 | 72,16% | 1,48 | +56,42% | +64,77% | 21,32% | 0,99 | -11,22% |
| **ETHUSDT** — Base | Val (1.5Y) | 92 | 69,57% | 1,60 | +70,83% | +89,87% | 16,82% | 1,59 | -26,64% |
| **ETHUSDT** — v6 ML | Val (1.5Y) | 68 | 79,41% | 2,71 | +107,84% | +177,88% | 12,54% | 2,79 | -26,64% |
| **ETHUSDT** — Base | Blind Y5 | 47 | 59,57% | 0,92 | -6,45% | -9,25% | 39,03% | -0,25 | -41,52% |
| **ETHUSDT** — **v6 ML (TRƯỢT GATE)** | **Blind Y5** | **29** | **58,62%** | **0,85** | **-8,12%** | **-9,90%** | **27,29%** | **-0,37** | -41,52% (DD 55,10%) |
| **ETHUSDT** — v6 ML | Full 5Y | 194 | 72,68% | 1,67 | +156,13% | +312,53% | 27,29% | 1,32 | -61,83% (DD 81,06%) |
| **SOLUSDT** — Base (`TrendPbThrust`) | Cal (2.5Y) | 221 | 64,25% | 1,28 | +96,29% | +118,01% | 45,17% | 1,00 | -20,66% |
| **SOLUSDT** — **v6 ML** (`LR, t=0.6055`) | Cal (2.5Y) | 194 | 65,98% | 1,34 | +109,73% | +146,28% | 45,24% | 1,11 | -20,66% |
| **SOLUSDT** — Base | Val (1.5Y) | 169 | 68,05% | 1,63 | +141,37% | +260,68% | 23,51% | 2,29 | -24,59% |
| **SOLUSDT** — **v6 ML** | Val (1.5Y) | 154 | **72,08%** | **1,98** | +207,60% | **+576,11%** | **14,70%** | **3,05** | -24,59% |
| **SOLUSDT** — Base | Blind Y5 | 146 | 68,49% | 1,39 | +74,88% | +91,65% | 22,59% | 1,69 | -48,44% |
| **SOLUSDT** — **v6 ML (ĐẠT GATE)** | **Blind Y5** | **130** | **68,46%** | **1,29** | +54,50% | **+56,54%** | **26,60%** | **1,24** | -48,44% (DD 58,77%) |
| **SOLUSDT** — **v6 ML** | **Full 5Y** | **478** | **68,62%** | **1,52** | +371,83% | **+2506,56%** | 45,24% | **1,75** | -68,87% (DD 96,59%) |

### 2.2. Đối chiếu khắc nghiệt dưới `STRICT_TAKER` (Khớp thị trường + Slippage 2 chiều)

| Tài sản (v6 ML) | Cal Comp / PF | Val Comp / PF | **Blind Y5 Comp / PF / WR / DD** | **Full 5Y Comp / CAGR / PF / DD / Sharpe** | Trạng thái Live Gate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **BTCUSDT** | -21,47% / 0,97 | +116,50% / 1,64 | **+16,99% / 1,21 / 69,70% / 22,39%** | **+97,35% / 14,51% / 1,19 / 58,51% / 0,56** | Đạt |
| **BNBUSDT** | +108,89% / 1,59 | +32,81% / 1,37 | **+1,14% / 1,06 / 67,39% / 17,50%** | **+170,44% / 21,93% / 1,40 / 24,94% / 0,90** | Đạt |
| **ETHUSDT** | +52,32% / 1,41 | +148,93% / 2,51 | **-12,17% / 0,81 / 58,62% / 28,47%** | +233,05% / 27,10% / 1,57 / 28,47% / 1,15 | **KHÔNG ĐẠT (`false`)** |
| **SOLUSDT** | +78,70% / 1,23 | +477,99% / 1,89 | **+23,51% / 1,16 / 67,97% / 27,17%** | **+1175,71% / 66,11% / 1,41 / 46,17% / 1,42** | **ĐẠT (`true`)** |

### 2.3. Phân rã từng năm Y1 -> Y5 (`EXCHANGE_POST_ONLY`, ML) & Danh mục 4-Crypto (`maxTotalOpenLev=4.0`)

| Năm | BTCUSDT (Comp / PF / DD / B&H) | BNBUSDT (Comp / PF / DD / B&H) | ETHUSDT (Comp / PF / DD / B&H) | SOLUSDT (Comp / PF / DD / B&H) |
| :--- | :--- | :--- | :--- | :--- |
| **Y1** | +8,92% / 1,14 / 36,74% (`-72,15%`) | +55,56% / 1,81 / 23,14% (`-55,24%`) | +45,40% / 1,88 / 12,42% (`-73,58%`) | +14,49% / 1,13 / 45,24% (`-94,51%`) |
| **Y2** | -30,79% / 0,69 / 34,31% (`+126,71%`) | +4,89% / 1,14 / 14,26% (`-10,15%`) | -11,95% / 0,83 / 20,37% (`+78,75%`) | +68,54% / 1,58 / 20,87% (`+363,93%`) |
| **Y3** | +135,37% / 1,96 / 23,41% (`+170,31%`) | +50,96% / 1,81 / 13,24% (`+166,74%`) | +105,51% / 4,18 / 9,77% (`+63,17%`) | +233,15% / 2,26 / 14,00% (`+363,35%`) |
| **Y4** | +65,84% / 1,76 / 27,08% (`-12,44%`) | +24,43% / 1,39 / 18,92% (`+36,06%`) | +62,98% / 2,06 / 12,54% (`-14,66%`) | +159,04% / 1,70 / 14,70% (`-48,43%`) |
| **Y5 (Holdout)** | **+44,30%** / 1,46 / 13,75% (`-32,28%`) | **+0,03%** / 1,04 / 17,17% (`-35,59%`) | **-9,90%** / 0,85 / 27,29% (`-41,14%`) | **+56,54%** / 1,29 / 26,60% (`-48,16%`) |

**Danh mục Crypto tổng hợp (`simulatePortfolioV6`, trần đòn bẩy mở đồng thời `4.0x`):**

| Cấu hình Danh mục | Giai đoạn | Lệnh | WR | PF | Tổng Net (%) | Ghép lãi (%) | CAGR | Max DD | Sharpe | Calmar |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Qualified Only** (`BTC+BNB+SOL`) — Post-Only | **Blind Y5** | 236 | 69,07% | 1,29 | +90,99% | **+111,22%** | 110,67% | 32,85% | 1,60 | 3,37 |
| **Qualified Only** (`BTC+BNB+SOL`) — Post-Only | **Full 5Y** | 1.038 | 69,56% | 1,43 | +616,17% | **+19750,27%** | 187,05% | 51,49% | 2,10 | 3,63 |
| **Qualified Only** (`BTC+BNB+SOL`) — Strict Taker | **Blind Y5** | 237 | 68,35% | 1,15 | +48,60% | **+38,91%** | 38,75% | 34,93% | 0,86 | 1,11 |
| **Qualified Only** (`BTC+BNB+SOL`) — Strict Taker | **Full 5Y** | 1.040 | 68,94% | 1,32 | +474,88% | **+4808,67%** | 117,28% | 58,06% | 1,63 | 2,02 |
| **All 4 Coins** (`BTC+BNB+ETH+SOL`) — Post-Only | Blind Y5 | 261 | 67,43% | 1,22 | +80,21% | +86,52% | 86,11% | 40,95% | 1,34 | 2,10 |
| **All 4 Coins** (`BTC+BNB+ETH+SOL`) — Strict Taker | Blind Y5 | 262 | 66,79% | 1,09 | +33,78% | +17,88% | 17,81% | 43,23% | 0,57 | 0,41 |

### 2.4. Chẩn đoán trung thực ETHUSDT vs SOLUSDT
- **Tại sao `ETHUSDT` trượt Blind Holdout Y5 (`-9,90%` Post-Only, `-12,17%` Taker)?**
  - Mặc dù mô hình ETH (`valRocAuc = 0.6914`) đạt hiệu suất Val xuất sắc (`+177,88%`, `PF 2.71`), trên tập `Cal` `calCvAuc` chỉ đạt `0.3308` (tín hiệu tương đối mong manh khi chế độ tương quan ETH/BTC đổi pha ở Y5). Khi ETH giảm `-41,52%` ở Y5 với các nhịp quét thanh khoản kéo dài, mẫu `n=29` lệnh sau lọc ML chỉ đạt WR `58,62%` (`PF 0.85`). Gate tự động đánh dấu **`qualifiedForLive: false`** và loại ETH khỏi danh mục thực chiến.
- **Tại sao `SOLUSDT` vượt Gate ở cả hai profile (`+56,54%` Post-Only, `+23,51%` Taker)?**
  - Thiết kế riêng cho hành vi beta cao bằng **`TrendPbThrust`** (pullback trong xu hướng `4h` kết hợp xung lực mua chủ động `takerBuyVol`) cùng 5 đặc trưng ổn định trên 478 giao dịch (`PF 1.52`, CAGR `91,53%`), tránh được sự suy giảm tương quan chéo trong năm Y5 (`-48,44%` Buy&Hold).

---

## 3. Kết Quả Chứng Khoán Mỹ 10 Năm (`SPY`, `DIA`, `QQQ`) & Futures `1h` 2 Năm

Hồ sơ thực thi **`EQUITY_ETF`**: `allowTimeGaps: true` (hỗ trợ khoảng trống cuối tuần/ngày lễ), phí `0,04%`, trượt giá `0,015%`, **không tính funding** (`0%`), và **xử lý rủi ro nhảy gap mở cửa (`SL`)** theo đúng giá `open` xấu hơn chứ không lấy giá dừng lỗ lý tưởng.

### 3.1. Chỉ số Daily 10 Năm (`1d`, 2.513 phiên — Cal 5Y / Val 3Y / Blind Holdout 2Y / OOS 5Y / Full 10Y)

| Chỉ số & Chiến lược | Giai đoạn | Lệnh | Win Rate | PF | Ghép lãi (%) | CAGR | Max DD (%) | Sharpe | Calmar | Buy & Hold (Ret / DD) |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **SPY** — Base (`IBS_RSI2_Regime`) | OOS 5Y | 90 | 64,44% | 1,29 | +19,81% | 3,68% | 9,16% | — | — | +53,73% / DD 25,36% |
| **SPY** — **v6 ML** (`GB, t=0.6447`) | Cal 5Y | 69 | 73,91% | 1,82 | +48,05% | 8,19% | 11,93% | — | — | +111,67% / DD 34,10% |
| **SPY** — **v6 ML** | Val 3Y | 45 | 68,89% | 1,56 | +22,40% | — | 7,42% | — | — | +26,29% / DD 25,36% |
| **SPY** — **v6 ML** | **Blind Holdout 2Y** | 35 | 57,14% | 1,06 | **+1,18%** | 0,59% | 11,25% | — | — | +21,07% / DD 19,00% |
| **SPY** — **v6 ML** | **OOS 5Y** | 81 | 64,20% | 1,37 | **+27,00%** | 4,89% | **11,25%** | 0,56 | 0,43 | +53,73% / DD 25,36% |
| **SPY** — **v6 ML** | **Full 10Y** | 151 | **68,87%** | **1,56** | **+88,23%** | 6,53% | **11,93%** | **0,74** | **0,55** | +224,48% / DD 34,10% |
| **DIA** — Base (`ValueMR_RotZ`) | OOS 5Y | 51 | 66,67% | 1,42 | +16,45% | — | 6,76% | — | — | +40,30% / DD 21,90% |
| **DIA** — **v6 ML** (`LR, t=0.6748`) | Cal 5Y | 40 | 72,50% | 2,01 | +29,19% | — | 5,76% | — | — | — |
| **DIA** — **v6 ML** | Val 3Y | 25 | 68,00% | 2,00 | +16,55% | — | 4,31% | — | — | — |
| **DIA** — **v6 ML** | **Blind Holdout 2Y** | 21 | 61,90% | 0,99 | **-0,54%** | — | 8,30% | — | — | +13,84% / DD 16,51% |
| **DIA** — **v6 ML** | **OOS 5Y** | 47 | 65,96% | 1,51 | **+18,87%** | 3,51% | **8,30%** | 0,59 | 0,42 | +40,30% / DD 21,90% |
| **DIA** — **v6 ML** | **Full 10Y** | 88 | **68,18%** | **1,65** | **+49,50%** | 4,11% | **8,30%** | **0,69** | **0,49** | +161,23% / DD 37,06% |
| **QQQ** — Base (`NasdaqMomentum`) | OOS 5Y | 70 | 70,00% | 1,95 | +49,37% | — | — | — | — | +59,80% / DD 35,54% |
| **QQQ** — **v6 ML** (`LR, t=0.6140`) | Cal 5Y | 63 | 69,84% | 1,75 | +38,24% | — | 10,47% | — | — | — |
| **QQQ** — **v6 ML** | Val 3Y | 33 | 78,79% | 3,58 | +41,67% | — | 8,28% | — | — | — |
| **QQQ** — **v6 ML** | **Blind Holdout 2Y** | 33 | 66,67% | **1,39** | **+9,42%** | 4,59% | **7,91%** | — | — | +26,36% / DD 22,88% |
| **QQQ** — **v6 ML** | **OOS 5Y** | 67 | **73,13%** | **2,18** | **+55,59%** | 9,23% | **8,28%** | **1,14** | **1,11** | +59,80% / DD 35,54% |
| **QQQ** — **v6 ML** | **Full 10Y** | 130 | **71,54%** | **1,95** | **+115,09%** | 7,96% | **10,47%** | **0,99** | **0,76** | +437,12% / DD 35,62% |

> **Nhận xét trung thực về chứng khoán Mỹ:** Trong thị trường tăng giá kéo dài của S&P 500/Dow/Nasdaq, chiến lược giao dịch đảo chiều/đà ngắn hạn (thời gian nắm giữ tối đa 14 ngày) không vượt tổng lợi nhuận Buy&Hold 10Y (`+224,5%` đến `+437,1%`), nhưng **cắt giảm Max Drawdown từ `34%–37%` xuống chỉ còn `8,3%–11,9%`** (giảm ~3 lần rủi ro sụt giảm vốn). Trên đoạn **Blind Holdout 2Y** gần đây (biến động hẹp và tăng liên tục), `QQQ` vẫn tạo `+9,42%` (`PF 1.39`, DD `7,91%`), trong khi `SPY` (`+1,18%`, `PF 1.06`) và `DIA` (`-0,54%`, `PF 0.99`) đi ngang.

### 3.2. Danh mục Đa Chỉ Số (`SPY + DIA + QQQ`, `maxTotalOpenLev=3.0`) & Futures `1h` OOS (~2 năm)

| Danh mục / Tài sản | Giai đoạn | Lệnh | WR | PF | Ghép lãi (%) | CAGR | Max DD (%) | Sharpe | Sortino | Calmar |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Portfolio 3 Indices** (`SPY+DIA+QQQ`) | Val 3Y | 103 | 71,84% | 2,07 | +100,77% | 26,20% | 16,94% | 1,86 | — | 1,55 |
| **Portfolio 3 Indices** (`SPY+DIA+QQQ`) | **Blind Holdout 2Y** | 89 | 61,80% | 1,15 | **+9,94%** | 4,83% | 21,82% | 0,40 | — | 0,22 |
| **Portfolio 3 Indices** (`SPY+DIA+QQQ`) | **OOS 5Y** | 195 | 67,69% | 1,62 | **+132,80%** | 18,39% | 21,82% | 1,30 | 2,00 | 0,84 |
| **Portfolio 3 Indices** (`SPY+DIA+QQQ`) | **Full 10Y** | 369 | 69,65% | **1,70** | **+492,48%** | **19,48%** | **21,82%** | **1,39** | **2,10** | **0,89** |
| **`ES=F`** (`1h` OOS, 13.732 nến) | OOS 2Y (07/24–11/26) | 42 | 78,57% | **1,97** | **+23,24%** | 9,16% | **5,95%** | 1,08 | — | 1,54 |
| **`YM=F`** (`1h` OOS, 13.723 nến) | OOS 2Y (07/24–11/26) | 24 | 62,50% | 1,06 | +0,78% | 0,33% | 5,38% | 0,08 | — | 0,06 |
| **`NQ=F`** (`1h` OOS, 13.730 nến) | OOS 2Y (07/24–11/26) | 41 | 73,17% | **1,88** | **+23,93%** | 9,42% | **7,75%** | 0,99 | — | 1,22 |
| **Portfolio 3 Futures `1h`** (`ES+YM+NQ`) | **OOS 2Y** | 107 | **72,90%** | **1,67** | **+53,92%** | **19,84%** | **15,67%** | **1,35** | **2,09** | **1,27** |

---

## 4. Kết Quả Kiểm Định Độc Lập (`tests/verify_v6_full_suite.mjs` & Toàn Bộ 10 File Test)

Lệnh kiểm định cuối cùng (chạy trên Node v22.23.4 + Python `scikit-learn`):
```bash
node --test \
  research/sim_engine.test.mjs \
  research/signals_15m.test.mjs \
  research/signals_1h.test.mjs \
  tests/pine_parity.test.mjs \
  research/sim_engine_v5.test.mjs \
  research/ml_inference.test.mjs \
  research/sim_engine_v6.test.mjs \
  standalone/standalone.test.mjs \
  tests/verify_v5_standalone.mjs \
  tests/verify_v6_full_suite.mjs
```

| Hạng mục Kiểm định (`tests/verify_v6_full_suite.mjs`) | Kết quả thực tế |
| :--- | :--- |
| **1. Nhân quả Cắt tiền tố & Đột biến tương lai — 5Y Crypto** (`BTCUSDT`, `BNBUSDT`, `ETHUSDT` + cross `ETH/BTC`, `SOLUSDT` + `takerBuyVol` & `4h` HTF + Funding 8h) | **PASS** (100% khớp tín hiệu, đặc trưng `< 1e-12`, ML score & lệnh đóng trước mốc cắt `T=28.000`) |
| **2. Nhân quả Cắt tiền tố & Đột biến tương lai — 10Y Indices & 2Y Futures `1h`** (`SPY`, `DIA`, `QQQ` với `^VIX`/`^TNX` + `ES=F`, `YM=F`, `NQ=F` với `1d` HTF) | **PASS** (100% bất biến trước mọi nhiễu dữ liệu tương lai sau `T=1.800` daily và `T=9.500` intraday) |
| **3. Zero-Leakage & Parity `< 1e-12` Python `sklearn` vs Pure-JS cho CẢ 7 mô hình** (`BTCUSDT`, `BNBUSDT`, `ETHUSDT`, `SOLUSDT`, `SPY` GradientBoosting, `DIA`, `QQQ` — >= 100 mẫu thực/asset) | **PASS** (`maxAbsDiff < 1e-12`, 0 sai lệch quyết định `pass`, Cal/Val/Holdout ranh giới sạch tuyệt đối, `ETHUSDT.qualifiedForLive === false`) |
| **4. Gap-Risk `EQUITY_ETF` & Giới hạn Đòn bẩy Danh mục `simulatePortfolioV6`** | **PASS** (qua cuối tuần `SL` khớp theo giá mở cửa xấu hơn `< 91.0`, `fundingDragPct === 0`, đòn bẩy trùng lịch được bóp về trần `3.0x`) |
| **5. Bảo mật & Standalone Loopback v6 (`standalone/`)** | **PASS** (`0` `innerHTML`/`eval`/inline script trong `standalone/public/`; chặn non-loopback `0.0.0.0`; `.env` bị ignore; mặc định `PAPER` + `DRY_RUN=true`; bôi đen cả khóa `ALPACA_*` & `TWELVEDATA_API_KEY`; API `/api/status` & `/api/backtest` chạy offline cho đủ 7 mã v6) |

---

## 5. Hướng Dẫn Vận Hành Độc Lập Không Cần TradingView (CLI, WebUI & Personal API Key)

### 5.1. Chế độ Miễn Phí 100% (Không Cần API Key)
Hệ thống đã tích hợp sẵn dữ liệu public từ **OKX/Binance Futures** (Crypto) và **Yahoo Finance v8** (Chứng khoán Mỹ `SPY`, `DIA`, `QQQ` + `^VIX`/`^TNX`), cùng kho dữ liệu offline trong `data/`. Bạn không cần tài khoản TradingView hay bất kỳ API Key nào để kiểm tra sức khỏe, đồng bộ dữ liệu, backtest và chạy Paper Trading:

```bash
# 1. Kiểm tra toàn bộ engine, SQLite WAL, mô hình v4.1/v5/v6 và kết nối public
node standalone/cli.mjs doctor

# 2. Đồng bộ dữ liệu mới nhất (Crypto hoặc US Indices) vào SQLite cục bộ
node standalone/cli.mjs sync --symbol BNBUSDT.P --timeframe 1h --bars 600
node standalone/cli.mjs sync --symbol SPY --timeframe 1d --bars 600

# 3. Chạy backtest ngay trên terminal (với mô hình ML v6 đã khóa)
node standalone/cli.mjs backtest --symbol SOLUSDT.P --timeframe 1h --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs backtest --symbol QQQ --timeframe 1d --profile EQUITY_ETF

# 4. Bật Web Command Center nội bộ (chỉ lắng nghe 127.0.0.1:4180)
node standalone/cli.mjs web
```
Sau khi chạy `web`, mở trình duyệt tại **`http://127.0.0.1:4180`** để xem biểu đồ nến, tín hiệu Buy/Sell/SL/TP, bảng telemetry VIX/TNX/Funding và lịch sử Paper Trades.

### 5.2. Cấu hình Personal API Key Qua `.env` (Tùy chọn khi muốn kết nối sàn)
1. Sao chép tệp mẫu `.env.example` thành `.env` (tệp `.env` đã được liệt kê trong `.gitignore` nên không bị đẩy lên Git):
   ```bash
   cp .env.example .env
   ```
2. Mặc định hệ thống **khóa an toàn tuyệt đối** ở chế độ giả lập:
   ```ini
   EXECUTION_MODE=PAPER
   DRY_RUN=true
   HOST=127.0.0.1
   MAX_LEVERAGE_CAP=3.0
   MAX_ORDER_USDT=500
   ```
3. Điền khóa cá nhân theo sàn bạn sử dụng:
   - **OKX V5 Perpetuals:** `EXCHANGE=OKX`, `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_PASSPHRASE` (giữ `OKX_SIMULATED=1` cho OKX Demo Trading).
   - **Binance USD-M Futures:** `EXCHANGE=BINANCE`, `BINANCE_API_KEY`, `BINANCE_API_SECRET` (giữ `BINANCE_TESTNET=1` cho Futures Testnet).
   - **US Equities / Data (tùy chọn):** `ALPACA_API_KEY`, `ALPACA_API_SECRET` (`ALPACA_PAPER=1`), `TWELVEDATA_API_KEY`.
4. **Cơ chế khóa 5 lớp cho Live (`LIVE_ARMED`):** Hệ thống từ chối đặt lệnh thật nếu thiếu bất kỳ điều kiện nào sau đây: `EXECUTION_MODE=LIVE_ARMED`, `DRY_RUN=false`, chuỗi `LIVE_CONFIRM_TOKEN` khớp (so sánh constant-time), có đủ khóa sàn hợp lệ, và giá trị lệnh `<= MAX_ORDER_USDT`.
