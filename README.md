# TRADING-TOOL (`SMC Confirmed [4.1.0]` & Autonomous Engine `v5 -> v13.0`)

Hệ thống giao dịch định lượng đa tài sản từ **TradingView Pine Script v6 (`[4.1.0]`)** tới nền tảng **Off-TradingView Node.js v22 Standalone & Multi-Tenant Commercial Autopilot (`v5.0` -> `v13.0`)**.

Mã nguồn Pine Script gốc giữ ghi nhận tác giả **BigBeluga** theo giấy phép **Mozilla Public License 2.0 (MPL 2.0)**.

---

## 1. Kiến trúc 2 lớp & Tiến hóa hệ thống (`v3.0 -> v13.0`)

### Lớp A — TradingView Pine Script v6 (`TOOL.pine` & `TOOL_Strategy.pine` `[4.1.0]`)
- **Chỉ báo & Chiến lược đối chiếu thuần Pine v6:** Giữ nguyên cấu trúc OB/FVG/Sweep, chạy 2 engine nhân quả chuẩn hóa riêng cho **`15m`** (`v4.0 H4-Close-Disp 15m_r3` / `v3.0 H1_CleanDisp_AtrExh`) và **`1h`** (`v3.0 AdaptiveTrapPolarity` + `v4.0 H4-Disp Trend`), kèm **Vol-Normalized Risk Sizing** và tùy chọn **Partial TP1 + Runner**.
- **An toàn khớp lệnh & Parity:** Dùng `LIMIT_PULLBACK`, SL bảo vệ sàn `%`, Confirmed-Close `BE+`, đúng **28 plot calls** và **4 `request.security(..., lookahead = barmerge.lookahead_off)`** vô điều kiện ở top-level.
- **Minh bạch bảng điểm & Strategy Tester:** Bảng điểm hiển thị rõ **`PF (Lev)=`** (khi bật VolNorm) hoặc **`PF (1x)=`** cạnh **`1x Net`**. `TOOL_Strategy.pine` đặt `process_orders_on_close = false` (lệnh thoát `market`/hết giờ ở Strategy Tester khớp theo giá mở cửa nến kế tiếp, khác 1 nhịp với quy tắc đóng nến bảo thủ trên bảng Paper).

### Lớp B — Động cơ Định lượng ML & Regime Ngoài TradingView (`v5.0 -> v9.0`)
| Thế hệ | Cột mốc cốt lõi | Tài liệu tham chiếu |
|---|---|---|
| **`v3.0`** | Pure Pine v6 `LIMIT_PULLBACK` + `BE+` đạt `100%_BAR_AND_TRADE_MATCH` (15m Holdout `73.53% WR`, 1h Holdout `74.51% WR`) | [EVALUATION_AND_RESEARCH_REPORT.md](docs/EVALUATION_AND_RESEARCH_REPORT.md) |
| **`v4.0 / v4.1`** | Mở rộng 3Y OKX Perpetuals (`1h_r5`, `15m_r3`), VolNorm (`avg 2.39x`), 8h funding & Partial TP1 | [research/results_v4/v41_profit_amp_summary.json](research/results_v4/v41_profit_amp_summary.json) |
| **`v5.0`** | Node.js Standalone + SQLite WAL + `EXCHANGE_POST_ONLY` + Real 8h Funding + Purged `sklearn` ML (`< 1e-12` Python/JS parity) | [V5_STANDALONE_AND_ML_REPORT.md](docs/V5_STANDALONE_AND_ML_REPORT.md) |
| **`v6.0`** | 5Y Crypto (`BTC, BNB, ETH, SOL` `1h`) tích hợp Orderflow CVD + 10Y US Stock Indices (`SPY, DIA, QQQ`) & 2Y Futures (`ES=F, YM=F, NQ=F`) | [V6_5Y_CRYPTO_AND_INDICES_REPORT.md](docs/V6_5Y_CRYPTO_AND_INDICES_REPORT.md) |
| **`v7.0`** | Two-Stage Maker Exit (`TP1 + Micro-BE+`) + kiểm toán thanh lý `mmr = 0.005` (`Liq = 0`) + Frontier `>=75% WR` & `>=30%/mo` Cal+Val | [V7_75WR_30PCT_MONTHLY_REPORT.md](docs/V7_75WR_30PCT_MONTHLY_REPORT.md) |
| **`v8.0`** | Causal Macro-Trend Regime Engine (`BULL_TREND`, `BEAR_TREND`, `BEAR_SQUEEZE`, `RANGE_CHOP`) + 16 mô hình L/S + Equities/Futures v8 | [V8_REGIME_ASYMMETRIC_MAXIMIZER_REPORT.md](docs/V8_REGIME_ASYMMETRIC_MAXIMIZER_REPORT.md) |
| **`v9.0`** | 3-Slice Cal/Val Sub-Period Screening (`F1 Bear 2022`, `F2 Recovery 2023`, `F3 Validation`) + Single Cal-Fit ML + Causal DD Guard + Cross-Asset All-Weather + Ma trận 10 thế hệ (`v1.4 -> v9.0`) | [V9_ALL_VERSIONS_PREVIEW_AND_OFF_TV_GUIDE.md](docs/V9_ALL_VERSIONS_PREVIEW_AND_OFF_TV_GUIDE.md) |

### Lớp C — Nền tảng Tự động hóa Off-TV & Thương mại Đa Thuê Bao (`v10.0 -> v13.0`)
- **`v10.0` (Multi-Tenant Vault SaaS):** Két sắt mã hóa khóa API bằng **AES-256-GCM + `scryptSync` + AAD** (`standalone/crypto_vault.mjs`), cấp phép ký HMAC `TT10.<payload>.<hmac24>` (`standalone/license_issuer.mjs`), định cỡ hợp đồng chính xác theo OKX `ctVal`/`lotSz` và Binance `stepSize`/`minNotionalUsdt`, 7 chốt chặn an toàn & `StandaloneOrderRouter` (`clOrdId` thuần chữ/số 1-32 ký tự `^[A-Za-z0-9]{1,32}$`). Xem [V10_COMMERCIAL_SAAS_AND_BUYER_ONBOARDING_GUIDE.md](docs/V10_COMMERCIAL_SAAS_AND_BUYER_ONBOARDING_GUIDE.md).
- **`v11.0 -> v12.5` (Autopilot 24/7 & Consumer Studio):** Daemon chạy nền `AutopilotScheduler`, **$1,000 Paper Sandbox** (0 API key), giao diện Sáng/Tối mặc định **Chế độ khách hàng** (`680px`, có nút **Chế độ chuyên gia** mở 3 tab + Quant Terminal), lưu khóa `.local-vault.secret` (`chmod 0600`), tự phục hồi `REARM_REQUIRED` sau restart và giữ nguyên SL/TP `reduceOnly` khi bấm Tạm dừng/Dừng ngay. Xem [v11-e2e-autopilot-user-flow-guide.md](docs/v11-e2e-autopilot-user-flow-guide.md).
- **`v13.0` (Security, Permission & Multi-Tenant Hardening):**
  - Truy vấn quyền `Withdraw` thực tế từ **OKX `GET /api/v5/account/config`** & **Binance `GET /fapi/v2/account`**; trả `403` nếu có quyền rút tiền và khóa an toàn mặc định **`UNVERIFIED_PERMISSIONS`** ở Guardrail 2.
  - Cô lập thuê bao theo `subscriberId` + kiểm tra trùng license `TT10` đang hoạt động (`findActiveSubscriberByLicenseKey`), chặn tự nâng cấp gói, kẹp trần đòn bẩy `<= 3.0x`, xác thực token/PIN cho `delete-profile`, kiểm tra `Origin` CSRF trên loopback `127.0.0.1`, phạm vi `SCAN_SIGNAL_EQUITY` cho US ETF (`INSTITUTIONAL_VIP`), và chuyển tiếp `resetTrips: true` qua `POST /api/commercial/subscribers/mode`.

---

## 2. Cài đặt Pine Script trên TradingView (`[4.1.0]`)

1. Mở TradingView -> **Pine Editor** -> tạo **Indicator mới** (dán [TOOL.pine](TOOL.pine)) hoặc **Strategy mới** (dán [TOOL_Strategy.pine](TOOL_Strategy.pine)).
2. Nhấn **Save** -> **Add to chart** (chỉ bật tối ưu trên khung **`15m`** hoặc **`1h`**).
3. Giữ mặc định **Signal mode = `SMC High-WinRate`** + **Auto-tune profile = ON** để chọn đúng nhánh `15m` (`<= 15m`) hoặc `1h` (`> 15m`), hoạt động trên mọi cặp OHLC chuẩn (`BTCUSDT`, `BTCUSDT.P`, `ETHUSDT`, OKX, Binance, Bybit...).

---

## 3. Vận hành Ngoài TradingView qua CLI & Web Console (`Node.js >= 22`)

Mặc định luôn khóa an toàn ở **`EXECUTION_MODE=PAPER`** và **`DRY_RUN=true`** trên địa chỉ loopback **`127.0.0.1:4180`** (không cần API key cho chế độ Paper Sandbox / dữ liệu public OKX, Binance & Yahoo Finance v8).

```bash
# 1. Kiểm tra sức khỏe toàn bộ engine (v4.1..v13), SQLite WAL, model parity & nguồn public
node standalone/cli.mjs doctor

# 2. Đồng bộ nến & funding mới nhất vào SQLite cục bộ
node standalone/cli.mjs sync --symbol BTCUSDT.P --timeframe 1h --bars 600
node standalone/cli.mjs sync --symbol SPY --timeframe 1d --bars 600

# 3. Chạy backtest & xem trạng thái Macro Regime v8
node standalone/cli.mjs backtest --version v9 --symbol BTCUSDT.P --timeframe 1h --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs regime --symbol BTCUSDT.P --timeframe 1h

# 4. Kiểm tra danh mục Frontier & Ma trận đối chiếu 10 thế hệ (v1.4 -> v9.0)
node standalone/cli.mjs portfolio --version v9 --tier SAFE_75WR --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs versions

# 5. Cấp mã bản quyền TT10 (Seller) & Mô phỏng phân tầng vốn/hợp đồng (Buyer)
node standalone/cli.mjs license --plan PRO_AUTO_TRADER --days 30 --ref buyer@example.com
node standalone/cli.mjs commercial-sim --equity 1500 --exchange OKX --version v9 --tier SAFE_75WR

# 6. Khởi động Web Command Center & Autopilot Scheduler tại http://127.0.0.1:4180
node standalone/cli.mjs serve
```

Tất cả 9 subcommand của `standalone/cli.mjs`: `doctor`, `sync`, `backtest`, `portfolio`, `regime`, `versions`, `license`, `commercial-sim`, `serve`.

---

## 4. Bộ kiểm định tự động (Node.js `>= 22`)

```bash
# Kiểm tra tĩnh Pine v6 (28 plots, 4 request.security lookahead_off, HISTORY_LIMIT 4500)
node tests/pine_static_check.mjs

# Kiểm tra parity từng nến & từng lệnh giữa Pine Script và sim_engine.mjs
node tests/pine_parity.mjs

# Chạy toàn bộ 21 test suite (Research + Pine Parity + Standalone + Commercial + E2E Autopilot v5..v13)
node --test \
  research/ml_inference.test.mjs \
  research/regime_engine_v8.test.mjs \
  research/signals_15m.test.mjs \
  research/signals_1h.test.mjs \
  research/sim_engine.test.mjs \
  research/sim_engine_v5.test.mjs \
  research/sim_engine_v6.test.mjs \
  research/sim_engine_v7.test.mjs \
  standalone/autopilot-scheduler.test.mjs \
  standalone/commercial_engine.test.mjs \
  standalone/crypto_vault.test.mjs \
  standalone/standalone.test.mjs \
  tests/pine_parity.test.mjs \
  tests/verify_v5_standalone.mjs \
  tests/verify_v6_full_suite.mjs \
  tests/verify_v7_75wr_30mo.mjs \
  tests/verify_v8_regime_maximizer.mjs \
  tests/verify_v9_preview_and_router.mjs \
  tests/verify_v10_commercial_platform.mjs \
  tests/verify-v11-e2e-autopilot.mjs \
  tests/verify-v12-human-ux-and-autopilot.mjs
```
