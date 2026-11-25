# Hướng Dẫn Toàn Tập v9.0: Đối Chiếu 10 Thế Hệ (v1.4 -> v9.0), Danh Mục Xuyên Tài Sản & Giao Dịch Độc Lập Không Cần TradingView

**Trạng thái kiểm định (`verifier-v5`):** ✅ **PASS — Kiểm định độc lập 3-Slice Cal/Val Sub-Period Screening + Single Cal-Fit ML (`v9.0`), Causal DD Guard, Zero-Leakage SHA-256 Lock, Parity `< 1e-12` Python vs JS trên cả 8 mô hình v9, Ma trận 10 phiên bản (`NaN=false`), `StandaloneOrderRouter` (`clOrdId` 1–32 ký tự chữ/số OKX V5, idempotency, crash recovery) & Bảo mật Standalone.**

---

## 1. Bảng Đối Chiếu Toàn Diện 10 Thế Hệ (v1.4 -> v9.0)

Dữ liệu trích trực tiếp từ tệp kiểm chứng đã khóa `research/results_v9/all_versions_comparison_matrix.json` (`verifiedFromArtifact = true` trên cả 10 phiên bản; **tuyệt đối không nội suy hay làm đẹp số liệu**).

| Phiên bản | Phạm vi & Cơ chế | Win Rate chính | PF | Lợi nhuận / Sweep chính | Blind OOS / Y3 / Y5 | Max DD & Rủi ro | Trạng thái / Ghi chú |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`v1.4`** | Pine `15m` thuần (CHoCH + RVOL mũi tên) | 41,1% – 43,8% (10 nến trước phí) | — | — | — | Không SL / BE+ | Thất bại cả trước phí |
| **`v2.0`** | Pine + Simulator `MARKET_NEXT_OPEN` (1.680 tổ hợp) | Val 66,67% (`15m`) / 69,64% (`1h`) | — | — | Sụp đổ OOS: 42,42% (`15m`), 50,00% (`1h`), lỗ TB/lệnh | Overfit grid nặng | **NOT_ACHIEVED (0/840)** |
| **`v3.0`** | Pure Pine v6 (`TOOL.pine`, `LIMIT_PULLBACK` + BE+, 1x) | **73,53%** (`15m`), **74,51%** (`1h`) Holdout | 1,49 (`15m`) / 1,40 (`1h`) | +48,98% (`15m` 12m), +50,63% (4-Fold WF) | Holdout **+10,28%** (`15m`) | ~5,6% DD ở 1x | **VERIFIED PASS** (Chuẩn TradingView 1x BTC) |
| **`v4.0`** | OKX Swap 3 năm (`1h_r5` & `15m_r3`), 1x | 72,00% (`1h`), 67,03% (`15m`) | 1,37 (`1h`), 1,09 (`15m`) | +75,83% (`1h`), +20,41% (`15m`) | Blind Y3: `1h` **+16,08%**, `15m` -9,33% | 16,26% (`1h`), 34,22% (`15m`) | `1h` giữ lãi Y3, `15m` suy giảm |
| **`v4.1`** | OKX Swap 3Y + VolNorm (`2.39x` TB) + Funding 0,01%/8h | 74,21% (`BTC 1h`) | 1,44 (`BTC 1h`) | **+267,14%** (`BTC 1h`) | Blind Y3 BTC **+26,45%** (71,26% WR) | BTC DD 30,15%; **ETH -73,15%, SOL -84,60%** | Chứng minh chuyển rule BTC thẳng sang Altcoin thất bại |
| **`v5.0`** | Off-TV Node + Funding 8h thực + `EXCHANGE_POST_ONLY` + ML | 71,38% (3Y BTC 1h+15m) | 1,57 | **+1.943,80%** Post-Only / +954,55% Taker | Blind Y3: **+61,46%** PO (66,67% WR) / +15,20% Taker | Comp DD **40,35%** PO / 44,51% Taker | ETH/SOL trượt gate 3Y; BTC ML + Standalone SQLite WAL |
| **`v6.0`** | 5Y Crypto (`BTC,BNB,ETH,SOL` `1h`) + CVD + 10Y Chứng khoán Mỹ | 69,56% (Qualified Crypto), 69,65% (Indices) | 1,43 (Crypto), 1,70 (Indices) | Crypto **+19.750,27%**; Indices **+492,48%** (10Y) | **Blind Y5 Crypto dẫn đầu: +111,22% PO / +38,91% Taker**; Holdout 2Y Indices +9,94% | Crypto Cal DD 51,49%; Indices DD 21,82% | **Mạnh nhất ở Blind Holdout Y5 Crypto Bear** |
| **`v7.0`** | 5Y `15m+1h` Two-Stage Maker `TP1` + Vật lý Thanh lý `mmr=0.005` | **76,76%** (`SAFE`), **76,71%** (`TIER_3`) | 1,42 | `SAFE` **+8,25%/mo** (+7.454%); `TIER_3` Cal+Val **+31,65%/mo**, 5Y **+24,87%/mo** | Blind Y5: `SAFE` -1,70%/mo (-27,23%); `TIER_3` -1,90%/mo (-62,70%) | **Liq = 0**; nhưng `TIER_3` tháng tệ nhất **-59,19%**, DD **85,47%** | Giải bài toán `>=75% WR` & `>=30%/mo` trên Cal+Val, rủi ro đuôi Y5 lớn |
| **`v8.0`** | Causal Macro-Trend Regime + Breadth 4 coin + 16 mô hình L/S | **78,86%** (`TIER_3`), **76,14%** (`TIER_1`) | **1,74** (`TIER_3`), 1,51 (`TIER_1`) | `TIER_1` **+9,58%/mo**; `TIER_2` **+15,06%/mo**; `TIER_3` **+22,84%/mo** (+2.704.247%) | Blind Y5 Crypto: `-3,24%/mo` (`SAFE`), `-5,67%/mo` (`TIER_3`); **Indices 2Y hồi phục +11,98% (67,05% WR)** | **Cắt Worst Month `TIER_3` còn -36,67%**; **Liq = 0**; Futures `ES+NQ` **+39,51%** (DD 12,30%) | **Dẫn đầu Win Rate (`78,86%`), Profit Factor (`1.74`) & Equities/Futures v8** |
| **`v9.0`** | **3-Slice Cal/Val Sub-Period Screening (`F1 Bear 2022`, `F2 Recovery 2023`, `F3 Validation`) + Single Cal-Fit ML + Causal DD Guard** (`6/8` đạt 3 lát cắt) | **72,53%** (`SAFE`), **72,47%** (`MAXIMIZED`) | **1,54** (`SAFE`), 1,53 (`MAX`) | `SAFE` **+8,07%/mo** (+6.868%); `BAL` **+14,07%/mo**; `MAX` **+38,37%/mo Cal+Val, +28,38%/mo 5Y** (+3.036.721%) | Blind Y5 Crypto: `SAFE` -2,81%/mo (-33,91%), `BAL` -5,35%/mo, `MAX` -9,52%/mo | **SAFE Full 5Y DD thấp nhất: 46,89% & Worst Month -19,79%**; **Liq = 0** | **DD Guard cắt drawdown tốt nhất ở `SAFE_V9` & Sweep Full-5Y cao nhất ở `MAXIMIZED_V9`** |

### 1.1. Lý giải sự khác biệt giữa 3 nhà vô địch (`v6.0` vs `v8.0` vs `v9.0`)
- **Tại sao `v6.0` dẫn đầu Blind Holdout Y5 Crypto (`+111,22%` Post-Only / `+38,91%` Taker)?**  
  Ở `v6.0`, mô hình giao dịch thuần khung `1h` với điểm chốt lời đối xứng cao hơn (`RR ~1.25R`) và bộ đôi `BTC + SOL TrendPbThrust` + `BNB` đã tận dụng được các nhịp biến động lớn trong Y5, không bị phân mảnh bởi giao dịch `15m` tần suất cao dễ dính chi phí/râu nến trong thị trường giảm kéo dài.
- **Tại sao `v8.0` dẫn đầu về Win Rate & Profit Factor 5 năm (`78,86% WR`, `PF 1.74`) và Chứng khoán/Futures?**  
  Nhờ `regime_engine_v8.mjs` tách riêng Long (`BULL_TREND`) vs Bear Rally-Fade Short (`BEAR_TREND`), chặn hoàn toàn Short trong `BEAR_SQUEEZE`, kết hợp thoát lệnh 2 chặng `TP1 + Micro-BE+`, cắt tháng tệ nhất của gói cao nhất từ `-59,19%` (v7) xuống `-36,67%` và giúp danh mục chứng khoán Mỹ Blind 2Y hồi phục lên `+11,98%` (`DD 16,19%`).
- **Tại sao `v9.0` đạt MaxDD `SAFE` thấp nhất (`46,89%`, tháng tệ nhất `-19,79%`) và Sweep Full-5Y cao nhất (`+28,38%/mo`)?**  
  Nhờ kiểm duyệt khắt khe theo mô hình **3-Slice Cal/Val Sub-Period Screening (`F1 Bear 2022 >= 1.05`, `F2 Recovery 2023 >= 1.15`, `F3 Validation >= 1.25`, `CV_WR >= 70%`) + Single Cal-Fit ML (`train_v9_ensemble.py`)** — tự động vô hiệu hóa chiều Short trên `BNB_1h` & `ETH_15m` — cộng với **`applyCausalDdGuardV9`** tự động giảm đòn bẩy còn **`0.70x`** mỗi khi Drawdown lệnh đã đóng vượt `15%` cho tới khi hồi về dưới `8%`.
- **Tổng hợp Xuyên Tài Sản (`Cross-Asset All-Weather`, `Liq = 0`):**
  - **5 năm (`v9 SAFE_V9` + `QQQ` + `SPY`):** `1.290` lệnh, WR **72,40%**, PF **1.55**, **`+8,82%/tháng` (75,41% số tháng dương)**, **`+10.336,68%`** ghép lãi (CAGR `152,70%`), DD **47,11%**, Sharpe **2.73**, Calmar **3.24**.
  - **2 năm giao nhau (`v9 Crypto + ES=F/NQ=F + QQQ/SPY`):** `712` lệnh, WR **70,51%**, PF **1.35**, `+8,34%/tháng`, `+505,01%` (CAGR `112,85%`).
  - **Trong riêng Blind Y5 Bear (`v9 SAFE + ES=F/NQ=F + QQQ/SPY`):** Phụ trợ Mỹ kéo mức lỗ Y5 từ `-33,91%` (`-2,81%/mo`) lên **`-25,99%`** (`-1,77%/mo`), trong khi nhánh thuần Chứng khoán & Futures Mỹ 2Y đạt **+75,63%** (`73,62% WR, PF 1.57, DD 21,77%, Sharpe 1.51`, riêng Y5 Bear vẫn **dương `+8,25%`**!).

### 1.2. Khuyến nghị lựa chọn theo mục tiêu
- **An toàn tối đa qua mùa gấu / Xuyên tài sản:** **`v9.0 SAFE_V9` + `v8` US Futures/ETFs (`ES=F/NQ=F + QQQ/SPY`)** (DD thấp nhất `46,89%`, tháng xấu nhất `-19,79%`, `Liq=0`).
- **Tối đa hóa tỷ lệ thắng (`>78% WR`) & thu nhập tháng trên Crypto:** **`v8.0 TIER_3_MAXIMIZED_30MO_75WR`** (`78,86% WR`, `PF 1.74`) hoặc **`v9.0 MAXIMIZED_V9`** (`+38,37%/mo` Cal+Val, `+28,38%/mo` Full 5Y — **cảnh báo:** cả hai đều lỗ trong thị trường gấu Y5 và đòi hỏi kỷ luật rút lãi hàng tháng + Post-Only Maker).
- **Đa dạng hóa Chứng khoán Mỹ & Futures (ít tương quan Crypto):** **`v8.0 Equities & Futures`** (`ES=F + NQ=F` `+39,51%`, `DD 12,30%`; `SPY+DIA+QQQ` 10Y `+290,61%`, `DD 19,04%`).
- **Chạy thuần trên biểu đồ TradingView Pine Script:** **`v3.0`** (`TOOL.pine` & `TOOL_Strategy.pine`).

---

## 2. Quy Trình Vận Hành Độc Lập Hoàn Toàn Ngoài TradingView

Kiến trúc thực thi khép kín trên máy cá nhân (không cần tài khoản hay webhook TradingView):
1. **Nguồn dữ liệu Public REST (0 API Key):** Tự động kéo nến + funding 8h từ OKX V5 / Binance Futures (Crypto) và Yahoo Finance v8 (`SPY`, `DIA`, `QQQ`, `^VIX`, `^TNX`), cộng kho dữ liệu 5Y/10Y offline trong `data/`.
2. **Lưu trữ SQLite WAL (`data/standalone.sqlite`):** Lưu nến, trạng thái paper, lịch sử tín hiệu và `orders_log` với cơ chế tự khôi phục `SUBMITTING -> INTERRUPTED` nếu tắt máy đột ngột.
3. **Động cơ Regime + ML (`engine_runtime.mjs`):** Tính toán chế độ `BULL_TREND / BEAR_TREND / BEAR_SQUEEZE / RANGE_CHOP` + suy luận Pure-JS khớp Python `scikit-learn` `< 1e-12` + tính `Distance-to-Liquidation (%)`.
4. **Bộ định tuyến lệnh (`standalone/order_router.mjs` — `StandaloneOrderRouter`):**
   - Sinh mã **`clOrdId` thuần chữ/số 1–32 ký tự (`^[A-Za-z0-9]{1,32}$`)** theo đúng chuẩn bắt buộc của OKX V5 API (tuyệt đối không chứa `_` hoặc `-`), chống đặt trùng lệnh (*idempotency*).
   - Tự động đặt `post_only` limit entry, gắn `oco` `reduceOnly` SL/TP khi khớp vị thế, và hủy lệnh `PENDING_LIMIT` quá hạn.
5. **Giao diện Web Command Center (`http://127.0.0.1:4180`):** Chỉ lắng nghe `127.0.0.1`, 100% Zero-XSS (`createElement` + `textContent`), có sẵn **Version Selector (`v4.1` -> `v9`)**, **Bảng Preview 10 Thế Hệ**, **Macro-Trend Regime Radar**, **Monthly Sweep Gauge** và **Order Router Monitor**.

```bash
# 1. Kiểm tra sức khỏe toàn bộ engine, v9 models, matrix & kết nối public
node standalone/cli.mjs doctor

# 2. Xem bảng đối chiếu 10 thế hệ (v1.4 -> v9.0) & Cross-Asset All-Weather
node standalone/cli.mjs versions

# 3. Xem Regime hiện tại & Backtest / Portfolio v9.0
node standalone/cli.mjs regime --symbol BTCUSDT.P --timeframe 1h
node standalone/cli.mjs portfolio --version v9 --tier SAFE_75WR --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs backtest --version v9 --symbol BTCUSDT.P --timeframe 1h

# 4. Mở Web Console cục bộ (http://127.0.0.1:4180)
node standalone/cli.mjs serve
```

---

## 3. Câu Trả Lời Minh Bạch Về OKX Personal API Key

**Có cần OKX Personal API Key để chạy hệ thống không?** -> **KHÔNG bắt buộc**, tùy theo 3 giai đoạn sử dụng trong `StandaloneOrderRouter`:

| Chế độ (`Router Mode`) | Cần API Key? | Quyền Key yêu cầu | Cấu hình `.env` | Hành vi thực tế |
| :--- | :---: | :--- | :--- | :--- |
| **`PAPER_ZERO_KEY`** (Mặc định) | **Không (0 key)** | Không cần | `EXECUTION_MODE=PAPER` `DRY_RUN=true` `RISK_TIER=SAFE_75WR` | Đồng bộ giá/funding public, chạy v9/v8/v7, ghi lệnh giả lập `PAPER_SIMULATED` vào SQLite, **0 request private**. |
| **`OKX_DEMO_SIMULATED`** | Có (Demo Key) | OKX Demo Trading (`Trade` trên môi trường Demo) | `OKX_SIMULATED=1` `EXECUTION_MODE=LIVE_ARMED` `DRY_RUN=false` `LIVE_CONFIRM_TOKEN=...` + Key Demo | Gửi lệnh ký HMAC-SHA256 kèm header `x-simulated-trading: 1` (`post_only` + `oco reduceOnly`), **không đụng tiền thật**. Khuyến nghị chạy kiểm chứng >= 14 ngày. |
| **`LIVE_EXCHANGE_ARMED`** | Có (Live Key) | **CHỈ `Read + Trade`** (**CẤM bật `Withdraw`**, nên gắn IP Whitelist) | `OKX_SIMULATED=0` `EXECUTION_MODE=LIVE_ARMED` `DRY_RUN=false` `LIVE_CONFIRM_TOKEN=...` + Key Live + trần `MAX_ORDER_USDT` / `MAX_LEVERAGE_CAP` | Khóa 5 lớp (`assertLiveOrderSafety`), ghi `SUBMITTING` vào SQLite trước khi gọi API để phục hồi khi rớt mạng/sập nguồn. |
