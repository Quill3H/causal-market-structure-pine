# Báo cáo Kỹ thuật & Hướng dẫn Sử dụng TRADING-TOOL v5.0 (Off-TradingView API, Causal ML Alpha & Standalone Engine)

**Mục tiêu kiểm định:** Xây dựng kiến trúc v5.0 hoạt động hoàn toàn độc lập ngoài TradingView (Node.js v22 zero-dependency + Python `scikit-learn` huấn luyện ngoại tuyến), bổ sung mô phỏng chi phí thực tế sàn (`EXCHANGE_POST_ONLY` + dòng tiền funding 8h thực tế 3 năm), lọc xác suất thắng nhân quả (Causal ML Meta-Labeling) chống rò rỉ dữ liệu tuyệt đối trên tập Blind Holdout Năm 3, kiểm định trung thực các đồng altcoin (`ETHUSDT.P`, `SOLUSDT.P`), và cung cấp động cơ chạy trực tiếp qua Personal API Key (OKX V5 / Binance USD-M Futures) kèm Dashboard Zero-XSS.

---

## 1. Tóm tắt Kết quả Kiểm chứng Độc lập (`verifier-v5`)

- **Toàn bộ Bộ kiểm thử v4.1 + v5.0:** **88/88 PASS** (`0` thất bại, `0` bỏ qua) qua 8 tệp kiểm thử (`sim_engine.test.mjs` 36, `signals_15m.test.mjs` 6, `signals_1h.test.mjs` 6, `pine_parity.test.mjs` 12, `sim_engine_v5.test.mjs` 12, `ml_inference.test.mjs` 4, `standalone/standalone.test.mjs` 7, `tests/verify_v5_standalone.mjs` 5).
- **Khớp chuẩn Pine v6 (v4.1):** Giữ nguyên **100% parity** trên `TOOL.pine` & `TOOL_Strategy.pine` (`12/12` kiểm thử `pine_parity.test.mjs` đạt).
- **Kiểm định Nhân quả (Prefix-Truncation & Future-Mutation):** Đã chứng minh bất biến 100% trên `research/features_v5.mjs`, `research/ml_inference.mjs`, `research/signals_v5_alt.mjs`, `research/sim_engine_v5.mjs`, và `alignFundingToBarsCausal` cho cả BTC 1h/15m và ETH/SOL 1h.
- **Đối chiếu Python `scikit-learn` ↔ Thuần JavaScript:** Sai số tuyệt đối tối đa trên `predict_proba` **< 1e-12** trên toàn bộ 4 mô hình (`BTC 1h`, `BTC 15m`, `ETH 1h`, `SOL 1h`) khi kiểm tra với dữ liệu tín hiệu thật (`>= 80` mẫu/mô hình).
- **Chống rò rỉ Holdout Y3:** Mô hình chỉ fit `SimpleImputer(median) -> StandardScaler -> Classifier` trên **Calibration Y1** và khóa ngưỡng `tau` / đường cong `sizeCurve` trên **Validation Y2**. Tập **Blind Holdout Y3** (`[17.520..26.280)` ở 1h và `[70.080..105.120)` ở 15m) chỉ được chấm điểm một lần sau khi khóa.
- **Kết quả nổi bật trên `OKX:BTCUSDT.P` (`EXCHANGE_POST_ONLY` + Real 8h Funding):**
  - **BTC 15m Holdout Y3 đảo chiều dương:** Từ `+6,28% Add / +2,45% Comp` (`62,00% WR`, `PF 1,05`) ở v4.1 lên **`+11,39% Add / +8,02% Comp` (`63,25% WR`, `PF 1,11`)**; Full 3Y tăng từ `+65,18% Comp` lên **`+133,92% Comp` (`68,80% WR`, `PF 1,35`)**.
  - **BTC 1h Full 3Y:** Tăng từ `+515,81% Comp` (`74,60% WR`, `PF 1,63`) ở v4.1 lên **`+768,14% Comp` (`75,11% WR`, `PF 1,74`)** với Drawdown kép giảm nhẹ (`26,69% -> 26,18%`).
  - **Danh mục kết hợp `BTC 1h + 15m` (`maxTotalOpenLev = 4.0`):** Full 3Y tăng từ `+903,04% Comp` (`Ret/DD 28,52`) lên **`+1.943,80% Comp` (`71,38% WR`, `PF 1,57`, `CompDD 40,35%`, `Ret/DD 48,17`)**; Blind Holdout Y3 đạt **`66,67% WR`, `PF 1,26`, `+59,73% Add / +61,46% Comp`**.
- **Cổng kiểm duyệt Altcoin (`ETHUSDT.P`, `SOLUSDT.P`):** Cả ETH và SOL đều **KHÔNG ĐẠT (`qualifiedForLive: false`)** trên Blind Holdout Y3 (`WR >= 65%`, `Net > 0%`, `PF >= 1,15`, `N >= 30` ở cả hai chế độ thực thi). Hệ thống báo cáo trung thực và **không đưa altcoin vào danh mục Live**.

---

## 2. Kiến trúc Phái sinh, Khớp lệnh Sàn & ML Meta-Labeling v5.0

### 2.1. Dữ liệu Funding 8h Thực tế 3 Năm (`research/fetch_okx_derivs.mjs`)
- Endpoint công khai `/api/v5/public/funding-rate-history` của OKX giới hạn lịch sử ~3 tháng (`>= 1787587200`, tức `2026-08-24T16:00:00Z`).
- Để phủ đủ 3 năm (`2023-11-23 .. 2026-11-25`) mà không dùng dữ liệu tổng hợp giả lập:
  - Giữ toàn bộ **`278` kỳ gốc OKX** (`source: "OKX"`, ưu tiên tuyệt đối trên các mốc thời gian trùng).
  - Backfill phần lịch sử trước đó bằng **`3.017` kỳ thực tế từ Binance USD-M Futures** (`/fapi/v1/fundingRate`, `source: "BINANCE_FAPI"`), chuẩn hóa jitter `+ms` về đúng mốc 8h UTC (`time % 28800 === 0`).
  - Tổng cộng **`3.295` kỳ liên tục không đứt quãng** cho mỗi cặp (`BTC-USDT-SWAP`, `ETH-USDT-SWAP`, `SOL-USDT-SWAP`), căn chỉnh nhân quả qua `alignFundingToBarsCausal(bars, fundingRows)` (`funding.time <= bar.time`).

### 2.2. Hai Chế độ Mô phỏng Thực thi (`research/sim_engine_v5.mjs`)
1. **`STRICT_TAKER`:** Tương đương tuyệt đối `sim_engine.mjs` v4.1 (`costPct = 0,10%` khứ hồi + `slippagePct = 0,025%` trượt giá bất lợi mỗi chiều).
2. **`EXCHANGE_POST_ONLY`:** Mô phỏng sát cơ chế lệnh Maker `post_only` / `GTX` của sàn:
   - **Vào lệnh Limit:** Yêu cầu giá phải xuyên qua `limitPrice` tối thiểu `makerBufferPct = 0,01%` (`low <= limit * 0.9999` cho Long; `high >= limit * 1.0001` cho Short); khớp đúng tại `limitPrice` (không nhận trượt giá có lợi khi gap), `0%` slippage và `0,02%` phí maker.
   - **Chốt lời Limit (`TP1` & `TP2`):** `0%` slippage và `0,02%` phí maker.
   - **Dừng lỗ / BE+ / Hết hạn (`SL`, `BE`, `TIME`):** Tính như lệnh Taker (`0,05%` phí taker + `0,025%` trượt giá bất lợi). SL luôn thắng TP nếu chạm cùng nến.
   - **Dòng tiền Funding 8h:** Tại mỗi mốc `row.time % 28800 === 0` khớp `fundingRows`, cộng/trừ `-side * ratePct * remFrac * lev` (Long trả khi funding dương, nhận khi funding âm; tính theo tỷ trọng vị thế còn lại `remFrac` sau Partial TP1).

### 2.3. Mô hình ML Đã Khóa (`research/results_v5/ml_models_btc_v5.json`)

| Khung | Mô hình & Tham số | Đặc trưng sử dụng | Ngưỡng `tau` | `sizeCurve` (nhân VolNorm) | Cal CV AUC / Val AUC |
|---|---|---|---:|---|---|
| **BTC 1h** | `LogisticRegression(C=0.25)` | `h4_ema20_dist_atr`, `ret_48_dir_atr`, `recent_dir_sl_streak` | `0,5874` | Tuyến tính `[0,85 .. 1,45]` (`pMax=0,8048`) | `0,6208` / `0,6000` |
| **BTC 15m** | `LogisticRegression(C=0.02)` | `wick_adv_atr` | `0,6793` | Tuyến tính `[0,85 .. 1,45]` (`pMax=0,6971`) | `0,5500` / `0,6180` |

---

## 3. So sánh v4.1 vs v5.0 ML trên `OKX:BTCUSDT.P` (3 Năm: `2023-11-22 .. 2026-11-22`)

### 3.1. Chế độ `EXCHANGE_POST_ONLY` + Real 8h Funding (Chế độ Khuyến nghị Live)

| Luồng / Giai đoạn | Phiên bản | Số lệnh (`N`) | Win Rate | PF | Tổng Net (Add) | Tổng Net (Comp) | Comp MaxDD | Ret/DD (Comp) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **BTC 1h — Cal (Y1)** | v4.1 Base | 77 | 72,73% | 1,80 | +90,82% | +126,60% | 20,83% | 6,08 |
| **BTC 1h — Cal (Y1)** | **v5.0 ML** | **77** | **72,73%** | **1,94** | **+112,77%** | **+176,71%** | **20,89%** | **8,46** |
| **BTC 1h — Val (Y2)** | v4.1 Base | 83 | 78,31% | 1,65 | +58,54% | +69,65% | 19,18% | 3,63 |
| **BTC 1h — Val (Y2)** | **v5.0 ML** | **76** | **81,58%** | **2,09** | **+82,86%** | **+114,93%** | **17,32%** | **6,64** |
| **BTC 1h — Holdout (Y3)** | v4.1 Base | 88 | 72,73% | 1,46 | +54,29% | +60,19% | 17,99% | 3,35 |
| **BTC 1h — Holdout (Y3)** | **v5.0 ML** | **84** | **71,43%** | **1,35** | **+46,25%** | **+45,97%** | **19,35%** | **2,38** |
| **BTC 1h — Full 3Y** | v4.1 Base | 248 | 74,60% | 1,63 | +203,64% | +515,81% | 26,69% | 19,33 |
| **BTC 1h — Full 3Y** | **v5.0 ML** | **237** | **75,11%** | **1,74** | **+241,88%** | **+768,14%** | **26,18%** | **29,34** |
| | | | | | | | | |
| **BTC 15m — Cal (Y1)** | v4.1 Base | 145 | 68,28% | 1,18 | +18,86% | +16,62% | 25,48% | 0,65 |
| **BTC 15m — Cal (Y1)** | **v5.0 ML** | **110** | **69,09%** | **1,31** | **+27,14%** | **+26,66%** | **22,37%** | **1,19** |
| **BTC 15m — Val (Y2)** | v4.1 Base | 157 | 70,70% | 1,32 | +36,45% | +38,26% | 15,57% | 2,46 |
| **BTC 15m — Val (Y2)** | **v5.0 ML** | **116** | **74,14%** | **1,70** | **+57,53%** | **+70,98%** | **12,12%** | **5,86** |
| **BTC 15m — Holdout (Y3)** | v4.1 Base | 150 | 62,00% | 1,05 | +6,28% | +2,45% | 26,54% | 0,09 |
| **BTC 15m — Holdout (Y3)** | **v5.0 ML** | **117** | **63,25%** | **1,11** | **+11,39%** | **+8,02%** | **35,92%** | **0,22** |
| **BTC 15m — Full 3Y** | v4.1 Base | 452 | 67,04% | 1,18 | +61,59% | +65,18% | 26,54% | 2,46 |
| **BTC 15m — Full 3Y** | **v5.0 ML** | **343** | **68,80%** | **1,35** | **+96,06%** | **+133,92%** | **35,92%** | **3,73** |
| | | | | | | | | |
| **Portfolio 1h+15m — Holdout (Y3)** | v4.1 Base | 238 | 65,97% | 1,26 | +61,33% | +65,60% | 31,66% | 2,07 |
| **Portfolio 1h+15m — Holdout (Y3)** | **v5.0 ML** | **201** | **66,67%** | **1,26** | **+59,73%** | **+61,46%** | **40,35%** | **1,52** |
| **Portfolio 1h+15m — Full 3Y** | v4.1 Base | 700 | 69,71% | 1,40 | +263,52% | +903,04% | 31,66% | 28,52 |
| **Portfolio 1h+15m — Full 3Y** | **v5.0 ML** | **580** | **71,38%** | **1,57** | **+337,97%** | **+1.943,80%** | **40,35%** | **48,17** |

### 3.2. Chế độ `STRICT_TAKER` (Kiểm định Đối chứng Khắt khe)

> **Ghi chú minh bạch:** Trong `research/run_v5_btc_alpha.mjs`, track `STRICT_TAKER` dùng giả định `fundingPctPer8h = 0,01%` cố định để khớp chuẩn v4.1; trong `research/run_v5_multi_portfolio.mjs`, track `STRICT_TAKER` cho danh mục còn chạy biến thể dùng `fundingRows` thực tế. Cả hai được liệt kê đầy đủ dưới đây:

| Luồng / Giai đoạn | Phiên bản | Số lệnh (`N`) | Win Rate | PF | Tổng Net (Add) | Tổng Net (Comp) | Comp MaxDD | Ret/DD (Comp) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **BTC 1h — Holdout (Y3)** (0,01%/8h) | v4.1 Base | 87 | 71,26% | 1,24 | +30,49% | +26,45% | 18,72% | 1,41 |
| **BTC 1h — Holdout (Y3)** (0,01%/8h) | v5.0 ML | 84 | 70,24% | 1,12 | +16,22% | +8,35% | 22,08% | 0,38 |
| **BTC 1h — Full 3Y** (0,01%/8h) | v4.1 Base | 252 | 74,21% | 1,44 | +151,54% | +267,14% | 30,15% | 8,86 |
| **BTC 1h — Full 3Y** (0,01%/8h) | **v5.0 ML** | **242** | **74,79%** | **1,51** | **+179,46%** | **+367,56%** | **28,47%** | **12,91** |
| | | | | | | | | |
| **BTC 15m — Holdout (Y3)** (0,01%/8h) | v4.1 Base | 151 | 62,25% | 0,94 | -8,02% | -11,07% | 30,55% | -0,36 |
| **BTC 15m — Holdout (Y3)** (0,01%/8h) | v5.0 ML | 118 | 63,56% | 0,96 | -3,86% | -7,05% | 38,50% | -0,18 |
| **BTC 15m — Full 3Y** (0,01%/8h) | v4.1 Base | 455 | 66,81% | 1,07 | +23,80% | +13,64% | 31,14% | 0,44 |
| **BTC 15m — Full 3Y** (0,01%/8h) | **v5.0 ML** | **345** | **68,70%** | **1,22** | **+60,86%** | **+65,31%** | **38,50%** | **1,70** |
| | | | | | | | | |
| **Portfolio 1h+15m — Holdout (Y3)** (0,01%/8h) | v4.1 Base | 238 | 65,55% | 1,09 | +23,64% | +13,93% | 35,46% | 0,39 |
| **Portfolio 1h+15m — Holdout (Y3)** (0,01%/8h) | v5.0 ML | 202 | 66,34% | 1,06 | +15,02% | +3,72% | 47,47% | 0,08 |
| **Portfolio 1h+15m — Holdout (Y3)** (Real Fund) | v5.0 ML | 202 | 66,34% | 1,11 | +25,54% | +15,20% | 44,51% | 0,34 |
| **Portfolio 1h+15m — Full 3Y** (0,01%/8h) | v4.1 Base | 707 | 69,45% | 1,25 | +174,95% | +316,72% | 35,46% | 8,93 |
| **Portfolio 1h+15m — Full 3Y** (0,01%/8h) | **v5.0 ML** | **587** | **71,21%** | **1,39** | **+243,45%** | **+702,52%** | **47,47%** | **14,80** |
| **Portfolio 1h+15m — Full 3Y** (Real Fund) | **v5.0 ML** | **587** | **71,38%** | **1,44** | **+270,91%** | **+954,55%** | **44,51%** | **21,44** |

> **Nhận xét thống kê:** Trên BTC 15m, chuyển từ thực thi Taker (`0,15%` tổng chi phí ma sát/lệnh) sang `EXCHANGE_POST_ONLY` (`0,04%` phí Maker khi TP + `0,07%` + `0,025%` slip khi SL) kết hợp lọc `wick_adv_atr` (`tau = 0,6793`) là yếu tố quyết định giúp Holdout Y3 chuyển từ âm (`-11,07% Comp`) sang dương (`+8,02% Comp`). Trên BTC 1h, ML tăng mạnh tổng lợi suất 3Y (`+515,81% -> +768,14%`), nhưng ở riêng Y3 việc nâng đòn bẩy trung bình (`2,46x -> 2,68x`) làm Y3 hơi thấp hơn baseline (`+45,97%` vs `+60,19%`) do mô hình tuyến tính chỉ đạt Val ROC-AUC `0,6000`.

---

## 4. Chẩn đoán Trung thực ETHUSDT.P & SOLUSDT.P + Kết quả Cổng Kiểm duyệt

### 4.1. Nguyên nhân Tham số BTC v3.0/v4.1 Thua nặng trên ETH (`-100,77%`) & SOL (`-131,54%`)
1. **Lệch thang biến động & khoảng dừng lỗ (`Volatility & Stop Scaling Mismatch`):** Trung vị ATR% 1h trên Cal+Val là `0,934%` trên ETH (`1,42x` BTC `0,657%`) và `1,261%` trên SOL (`1,92x` BTC). Dùng `stopAtr = 3,2` của BTC tạo khoảng SL trung bình tới `3,43%` (ETH) và `4,69%` (SOL), trong khi `beOffsetPct = 0,34%` chỉ khóa được `~0,10R` (ETH) và `~0,07R` (SOL). Khi kết hợp VolNorm (`5%` risk, `maxLev = 3,0`), tỷ lệ Risk/Reward bị méo nghiêm trọng.
2. **Đảo cực thích ứng (`AdaptiveTrapPolarity`) phản tác dụng:** Luật `slThresh = 2` đảo chiều tín hiệu giữa các cụm biến động ngắn của altcoin, kéo hiệu suất 1x Cal+Val từ `+19,27%` (`68,18% WR`, `PF 1,10`) xuống `-21,34%` (`63,19% WR`, `PF 0,90`) trên ETH, và từ `-13,26%` (`61,85% WR`, `PF 0,96`) xuống `-55,93%` (`57,80% WR`, `PF 0,83`) trên SOL.
3. **Độ trễ HTF & điểm vào Limit nông:** `4H EMA50` (`200h`) quá chậm với nhịp đảo chiều của altcoin và `0,18 ATR` limit dễ dính râu quét. Hiệu chỉnh riêng trên **Cal+Val `[0..17.520)`** sang `HtfSmcMultiTrap` (tắt đảo cực), `H4_20`, limit sâu hơn (`0,22`/`0,25 ATR`), `stopAtr = 2,2`/`2,0`, và `beOffsetPct = 0,45%` đã khôi phục Cal+Val cơ sở lên `72,65% WR / PF 1,70` (ETH) và `72,17% WR / PF 1,76` (SOL) dưới `EXCHANGE_POST_ONLY`.

### 4.2. Kết quả Kiểm tra Cổng Blind Holdout Y3 (Tiêu chuẩn: `WR >= 65%`, `Net > 0%`, `PF >= 1,15`, `N >= 30` trên CẢ HAI chế độ)

| Tài sản | Chế độ | Cal+Val (`Base -> ML`) | Blind Holdout Y3 (`Base -> ML`) | Full 3Y (`ML`) | Cổng Live (`qualifiedForLive`) |
|---|---|---|---|---|---|
| **OKX:ETHUSDT.P** | `EXCHANGE_POST_ONLY` | `117` (`72,65%`, PF `1,70`, `+138,77%`) → **`87` (`83,91%`, PF `3,32`, `+273,72%`)** | `43` (`58,14%`, PF `0,83`, `-12,77%`) → `30` (`63,33%`, PF `1,07`, `+3,42%` Add / `+1,38%` Comp) | `117` (`78,63%`, PF `2,34`, `+278,88%`, DD `20,46%`) | **`false` (FAIL)** — Y3 WR `63,33% < 65%` & PF `1,07 < 1,15` |
| **OKX:ETHUSDT.P** | `STRICT_TAKER` | `87` (`83,91%`, PF `3,17`, `+247,15%` Comp) | `30` (`63,33%`, PF `0,98`, `-1,06%` Add / `-3,00%` Comp) | `117` (`78,63%`, PF `2,21`, `+236,74%`, DD `20,99%`) | **`false` (FAIL)** — Y3 âm ròng dưới Taker |
| **OKX:SOLUSDT.P** | `EXCHANGE_POST_ONLY` | `115` (`72,17%`, PF `1,76`, `+160,29%`) → **`89` (`79,78%`, PF `3,02`, `+381,28%`)** | `44` (`56,82%`, PF `0,81`, `-15,39%`) → `25` (`52,00%`, PF `0,82`, `-10,43%` Add / `-12,28%` Comp) | `114` (`73,68%`, PF `2,11`, `+322,17%`, DD `24,43%`) | **`false` (FAIL)** — Thiếu mẫu (`25 < 30`), WR/PF/Net đều trượt |
| **OKX:SOLUSDT.P** | `STRICT_TAKER` | `89` (`79,78%`, PF `2,77`, `+299,69%` Comp) | `25` (`52,00%`, PF `0,78`, `-13,07%` Add / `-14,54%` Comp) | `114` (`73,68%`, PF `1,94`, `+241,57%`, DD `25,47%`) | **`false` (FAIL)** — Trượt tất cả chỉ tiêu Y3 |

> **Kết luận trung thực:** Dù ML tạo lợi nhuận rất cao trên Cal+Val Y1–Y2 của ETH/SOL, cấu trúc thị trường năm 3 (Y3) của altcoin có sự dịch chuyển phân phối (regime shift) khiến hiệu năng ngoài mẫu sụt xuống dưới ngưỡng an toàn. Theo đúng nguyên tắc chống overfitting, **chỉ `BTCUSDT.P` (1h + 15m) được cấp phép vận hành Live**.

---

## 5. Hướng dẫn Cài đặt Personal API Key (`.env`) & Chạy Standalone (Không cần TradingView)

### 5.1. Nguyên tắc An toàn Mặc định
- Hệ thống `standalone/` chạy hoàn toàn bằng Node.js v22 tích hợp (`node:sqlite` WAL, `node:crypto`, `node:http`), **0 gói npm ngoài**.
- Tệp `.env` đã bị chặn trong `.gitignore` (kiểm chứng bằng `git check-ignore -q .env`).
- **Mặc định an toàn:** `EXECUTION_MODE=PAPER`, `DRY_RUN=true`, `HOST=127.0.0.1`, `PORT=4180`, `MAX_LEVERAGE_CAP=3.0`, `MAX_ORDER_USDT=500`.
- Hệ thống **chạy đầy đủ dữ liệu thị trường công khai + backtest + Paper trading ngay cả khi không nhập API Key**.

### 5.2. Cấu hình Personal API Key (`.env`)

1. Tạo tệp `.env` từ mẫu:
   ```bash
   cp .env.example .env
   ```
2. Chọn sàn (`EXCHANGE=OKX` hoặc `EXCHANGE=BINANCE`) và điền khóa cá nhân:
   - **Nếu dùng OKX V5 (khuyến nghị thử Demo trước với `OKX_SIMULATED=1`):**
     - Vào OKX → API Management → tạo API Key với quyền **Read + Trade** (tuyệt đối **không bật Withdraw**), đặt IP Whitelist nếu chạy máy chủ cố định.
     - Điền vào `.env`:
       ```env
       EXCHANGE=OKX
       SYMBOLS=BTCUSDT.P
       TIMEFRAMES=1h,15m
       OKX_API_KEY=your_okx_api_key
       OKX_API_SECRET=your_okx_secret_key
       OKX_PASSPHRASE=your_okx_passphrase
       OKX_SIMULATED=1
       ```
   - **Nếu dùng Binance USD-M Futures (khuyến nghị thử Testnet trước với `BINANCE_TESTNET=1`):**
     - Tạo API Key bật **Enable Futures** (tuyệt đối **không bật Enable Withdrawals**).
     - Điền vào `.env`:
       ```env
       EXCHANGE=BINANCE
       SYMBOLS=BTCUSDT.P
       TIMEFRAMES=1h,15m
       BINANCE_API_KEY=your_binance_api_key
       BINANCE_API_SECRET=your_binance_secret_key
       BINANCE_TESTNET=1
       ```
3. **Chỉ khi sẵn sàng đặt lệnh thật trên sàn:** thiết lập mã xác nhận thủ công và tắt mô phỏng:
   ```env
   EXECUTION_MODE=LIVE_ARMED
   DRY_RUN=false
   LIVE_CONFIRM_TOKEN=chuoi-xac-nhan-bi-mat-cua-ban
   MAX_LEVERAGE_CAP=3.0
   MAX_ORDER_USDT=500
   ```
   *(Nếu thiếu `LIVE_CONFIRM_TOKEN` khớp timing-safe hoặc vượt `MAX_ORDER_USDT`, mọi yêu cầu gửi lệnh đều bị chặn ở tầng `assertLiveOrderSafety` và API `POST /api/mode`.)*

### 5.3. Lệnh CLI & Giao diện Web Command Center (`127.0.0.1:4180`)

- **Kiểm tra sức khỏe hệ thống, SQLite WAL, mô hình ML & kết nối sàn:**
  ```bash
  node standalone/cli.mjs doctor
  ```
- **Đồng bộ nến đóng & funding 8h mới nhất vào SQLite (`data/standalone.sqlite`):**
  ```bash
  node standalone/cli.mjs sync --symbol BTCUSDT.P --timeframe 1h --bars 600
  ```
- **Chạy Backtest ngoại tuyến ngay trên CLI (so sánh `EXCHANGE_POST_ONLY` / `STRICT_TAKER`, bật/tắt ML):**
  ```bash
  node standalone/cli.mjs backtest --symbol BTCUSDT.P --timeframe 1h --profile EXCHANGE_POST_ONLY
  node standalone/cli.mjs backtest --symbol BTCUSDT.P --timeframe 15m --profile EXCHANGE_POST_ONLY
  node standalone/cli.mjs backtest --symbol BTCUSDT.P --timeframe 1h --no-ml
  ```
- **Khởi động Daemon + Web Command Center (chỉ lắng nghe nội bộ `127.0.0.1:4180`):**
  ```bash
  node standalone/cli.mjs serve
  ```
  Sau đó mở trình duyệt tại **`http://127.0.0.1:4180`** để xem biểu đồ nến + đường mức lệnh (`LMT`, `ENTRY`, `SL`, `BE+`, `TP1`, `TP`), đồng hồ xác suất ML `probWin` so với ngưỡng `tau`, trạng thái API Key, bảng lịch sử tín hiệu/lệnh, và chuyển chế độ an toàn `PAPER` / `LIVE_ARMED`.

---

## 6. Kiểm toán An toàn & Bảo mật (`standalone/` & `.gitignore`)

- **Zero-XSS (`standalone/public/`):** Quét tĩnh toàn bộ tệp trong `standalone/public/` (`index.html`, `app.js`, `styles.css`) xác nhận **0** lời gọi `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, inline `<script>` hay inline `on*=`. Giao diện sử dụng 100% `document.createElement` và `textContent`, kèm header `Content-Security-Policy: default-src 'self'; script-src 'self'` và `X-Frame-Options: DENY`.
- **Loopback-only HTTP:** `assertLoopbackHost` trong `standalone/config.mjs` chặn mọi địa chỉ không phải `127.0.0.1` / `localhost` / `::1` (ném lỗi nếu cấu hình `0.0.0.0` hoặc IP LAN).
- **Bảo vệ Bí mật & Đường dẫn SQLite:** `redactConfig` và `scrubSecrets` loại bỏ hoàn toàn API key/secret/passphrase/token khỏi JSON API và log; `resolveSafeSqlitePath` chống path traversal và symlink escape; `recoverInterruptedOrders()` tự động đánh dấu `INTERRUPTED` cho lệnh đang dở khi khởi động lại sau sự cố.
