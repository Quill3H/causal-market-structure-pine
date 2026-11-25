# Hướng Dẫn Thương Mại Hóa SMC v10.0 Commercial SaaS & Quy Trình Onboarding Người Mua (Non-Custodial)

**Trạng thái kiểm định (`verifier-v5`):** ✅ **PASS — Kiểm định độc lập Két sắt AES-256-GCM (0 plaintext trên `.sqlite`), Toán học Contract OKX `ctVal` / Binance `stepSize` ($60 / $1,500 / $25,000), 7 Rào cản An toàn Thương mại, Multi-Tenant Idempotent `clOrdId` & E2E HTTP Loopback + Zero-XSS.**

> [!IMPORTANT]
> **Ranh giới Pháp lý & An toàn Tài sản:** Hệ thống **KHÔNG** phải dịch vụ tư vấn tài chính, không nhận ủy thác/giữ tiền (100% **Non-Custodial** — tiền luôn nằm trên tài khoản OKX / Binance của người mua), chỉ chấp nhận API Key có quyền **`Read + Trade`** (**CẤM tuyệt đối quyền `Withdraw`**), và luôn mặc định ở chế độ an toàn **`EXECUTION_MODE=PAPER`** / **`SCAN_AND_SIGNAL_ONLY`**.

---

## 1. Kiến Trúc Tổng Thể Thương Mại Hóa SaaS (Seller / Operator vs Buyer)

```
┌───────────────────────── SELLER / OPERATOR HOST (127.0.0.1 / Private VPS) ─────────────────────────┐
│ 1. License Issuer (standalone/license_issuer.mjs)                                                   │
│    └─ Ký mã bản quyền TT10.<payload>.<hmac24> theo gói ($29 / $79 / $199)                           │
│ 2. Strategy & Regime Engine (v4.1 .. v9.0 + Macro-Trend Radar + ML Inference < 1e-12)               │
│    └─ Quét thị trường 4 coin Crypto (BTC, SOL, BNB, ETH) + US ETFs (SPY, DIA, QQQ)                  │
│ 3. Multi-Tenant Commercial Engine & SQLite WAL (commercial_engine.mjs + commercial_store.mjs)       │
│    ├─ Két sắt AES-256-GCM + scryptSync + AAD (`subscriberId|exchange`)                              │
│    ├─ Quét số dư & tính Contract Sizing riêng theo vốn từng Buyer (`subscriber_signal_tickets`)     │
│    └─ 7 Guardrails + Tenant `clOrdId` (`^[A-Za-z0-9]{1,32}$`) + Crash Recovery                      │
└───────────────────────────────────────┬─────────────────────────────────────────────────────────────┘
                                        │ (CHỈ gửi lệnh Read / Post-Only / OCO SL-TP)
                                        ▼
┌───────────────────────── BUYER EXCHANGE ACCOUNT (Non-Custodial) ────────────────────────────────────┐
│ OKX V5 Swap / Binance USD-M Futures — Tiền nằm 100% tại sàn của Buyer, Withdraw = TẮT (Hard-Block) │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Người bán / Vận hành (Seller/Operator):** Sở hữu máy chủ chạy thuật toán v9.0/v8.0/v6.0, cấp mã `TT10...` cho từng khách hàng theo gói, giám sát trạng thái hệ thống qua `GET /api/commercial/admin/overview` (chỉ thấy số dư tóm tắt & trạng thái Masked Key `okx_****9f2a`, **không thể** thấy API Secret thô hay `sessionToken`/`armingPin` của khách).
- **Người mua / Nhà đầu tư (Buyer/Subscriber):** Nhận mã `TT10...`, kết nối sàn (hoặc dùng chế độ quét thử không cần API Key `POST /api/commercial/simulate-scan`), tự chọn chế độ từ chỉ nhận phiếu tín hiệu (`SCAN_AND_SIGNAL_ONLY`) -> thử nghiệm trên OKX Demo (`DEMO_AUTO_TRADE`) -> tự động hóa có mã PIN bảo vệ (`LIVE_AUTO_TRADE`).

---

## 2. 3 Gói Dịch Vụ Thương Mại (`COMMERCIAL_PLANS`)

| Mã gói (`planId`) | Giá tham khảo | Chế độ cho phép (`allowedModes`) | Trần vốn tối đa (`maxCapitalUsdt`) | Số vị thế đồng thời | Tài sản được quét (`allowedSymbols`) | Phiên bản chiến lược |
| :--- | :---: | :--- | :---: | :---: | :--- | :--- |
| **`STARTER_SCAN_SIGNAL`** | **$29 / tháng** | `SCAN_AND_SIGNAL_ONLY` (Cấm auto-trade) | **$5,000** | **2** | `BTCUSDT.P`, `SOLUSDT.P`, `BNBUSDT.P` | `v6`, `v8`, `v9` |
| **`PRO_AUTO_TRADER`** | **$79 / tháng** | `SCAN_AND_SIGNAL_ONLY`, `DEMO_AUTO_TRADE`, `LIVE_AUTO_TRADE` | **$25,000** | **4** | `BTCUSDT.P`, `ETHUSDT.P`, `SOLUSDT.P`, `BNBUSDT.P` | `v4.1` .. `v9` |
| **`INSTITUTIONAL_VIP`** | **$199 / tháng** | `SCAN_AND_SIGNAL_ONLY`, `DEMO_AUTO_TRADE`, `LIVE_AUTO_TRADE` | **$250,000** | **8** | Toàn bộ 4 Crypto + `SPY`, `DIA`, `QQQ` | `v4.1` .. `v9` |

---

## 3. Phân Tầng Vốn (`Capital Brackets`), Quét Tài Khoản & Toán Học Contract Sizing

Khi chạy `POST /api/commercial/simulate-scan` hoặc `POST /api/commercial/subscribers/scan`, hệ thống phân loại tài khoản vào 3 tầng vốn (`classifyCapitalBracket`) và tính chính xác từng lô hợp đồng thực tế trên OKX và Binance:

| Tầng vốn (`Capital Bracket`) | Ngưỡng vốn (`equityUsdt`) | Gợi ý cặp tiền | Vị thế đồng thời tối đa | Rủi ro mặc định / lệnh | Đặc điểm làm tròn hợp đồng thực tế (`computeExchangeOrderSizing`) |
| :--- | :---: | :--- | :---: | :---: | :--- |
| **`MICRO`** | `< $150` | `SOLUSDT.P`, `BNBUSDT.P`, `BTCUSDT.P` | **1** | `1.0%` | Ví dụ **$60** (dừng lỗ 2%, target notional **$30**): Trên **Binance `BTCUSDT`** (`minNotionalUsdt = $100`) sẽ bị đánh dấu `feasible: false` (`BELOW_BINANCE_MIN_NOTIONAL`), hệ thống tự lọc để trade **`SOLUSDT` (`0.1 SOL` >= $5)** hoặc **OKX `BTC-USDT-SWAP`** (`ctVal = 0.01`, `minSz = 0.01` = `$9` -> đặt được `0.03` cont). Nếu vốn quá nhỏ (`$15`), OKX BTC cũng trả `BELOW_OKX_MIN_SZ`. |
| **`STANDARD`** | `$150 – $2,000` | `BTCUSDT.P`, `SOLUSDT.P`, `BNBUSDT.P` | **3** | `1.0%` | Ví dụ **$1,500** (`targetNotional = $750`): **OKX `BTC-USDT-SWAP`** ra `0.83` cont (`0.0083 BTC`, tick `0.1`), **Binance `BTCUSDT`** ra `0.008 BTC` (`stepSize = 0.001`). |
| **`PRO_WHALE`** | `> $2,000` | `BTCUSDT.P`, `ETHUSDT.P`, `SOLUSDT.P`, `BNBUSDT.P` | **4** | `1.25%` | Ví dụ **$25,000** (`risk = $312.50`, `targetNotional = $15,625`): **OKX `BTC-USDT-SWAP`** ra `17.36` cont (`0.1736 BTC`), **Binance `BTCUSDT`** ra `0.173 BTC` (`~$15,570`). Bị chặn trần bởi `equity * maxLeverageCap`, `availMargin * 0.85 * maxLeverageCap`, và `maxCapitalUsdt` của gói. |

---

## 4. 7 Rào Cản An Toàn Thương Mại (`7 Commercial Guardrails`)

Mọi chu kỳ giao dịch tự động (`runSubscriberAutoTradeCycle`) đều phải vượt qua lần lượt 7 chốt chặn cứng trước khi ký lệnh gửi sàn:

1. **Chốt 1 — Bản quyền `TT10` hợp lệ & đúng quyền chế độ:** Kiểm tra HMAC-SHA256 hằng số thời gian (`timingSafeEqual`), chưa hết hạn (`expiresAtMs > nowMs`), và gói hiện tại cho phép chế độ (`STARTER_SCAN_SIGNAL` không thể chạy auto-trade).
2. **Chốt 2 — API Key Sạch (`Withdraw` Bắt Buộc Tắt):** `inspectApiKeyPermissions` kiểm tra payload quyền từ OKX/Binance. Bất kỳ key nào có `withdraw` / `enableWithdrawals: true` đều bị gắn `safeForAutoTrade: false` và **chặn `403`** ngay lúc onboarding lẫn lúc vào lệnh.
3. **Chốt 3 — Mã PIN Giao Dịch (`armingPin`) & Khóa Vault `>= 32` ký tự:** Chế độ `DEMO_AUTO_TRADE` / `LIVE_AUTO_TRADE` yêu cầu đúng `armingPin` đã băm bằng `scrypt`. Riêng `LIVE_AUTO_TRADE` bắt buộc biến môi trường `COMMERCIAL_MASTER_KEY >= 32` ký tự.
4. **Chốt 4 — Cầu Chì Lỗ Ngày (`Daily Loss Circuit Breaker`):** Tự động ngắt mọi lệnh mới nếu vốn ngày UTC giảm vượt `max_daily_loss_pct` (mặc định `5.0%`).
5. **Chốt 5 — Công Tắc Khẩn Cấp Đỉnh Vốn (`High-Water MaxDD Kill Switch`):** Theo dõi `high_water_equity_usdt`; nếu sụt giảm từ đỉnh vượt `max_dd_kill_pct` (mặc định `20.0%`), tự động đóng băng vĩnh viễn cho đến khi người dùng chủ động reset (`resetTrips: true`).
6. **Chốt 6 — Trần Vốn Gói & Trần Đòn Bẩy:** Từ chối đặt lệnh nếu `total_equity_usdt > plan.maxCapitalUsdt` hoặc đòn bẩy vượt `max_leverage_cap` (mặc định `3.0x`).
7. **Chốt 7 — Khớp Lô Sàn, Mã Chống Trùng Đa Thuê Bao & Phục Hồi Sau Sự Cố:** Chỉ đặt lệnh khi `feasible === true`, dùng `makeTenantClientOrderId` thuần chữ/số 1–32 ký tự (`^[A-Za-z0-9]{1,32}$`) tách biệt từng thuê bao, đặt `post_only` + `oco reduceOnly`, và tự chuyển trạng thái `SUBMITTING -> INTERRUPTED` nếu máy chủ tắt đột ngột.

---

## 5. Hướng Dẫn Vận Hành Từng Bước (CLI, REST API & WebUI)

### A. Cấu hình `.env` cho Seller / Operator
```bash
# Giữ nguyên mặc định an toàn của daemon cục bộ
HOST=127.0.0.1
PORT=4180
EXECUTION_MODE=PAPER
DRY_RUN=true

# Bộ 3 khóa thương mại (BẮT BUỘC đặt chuỗi ngẫu nhiên mạnh trên môi trường thật; không commit .env)
COMMERCIAL_MASTER_KEY="thay-bang-chuoi-bi-mat-toi-thieu-32-ky-tu-ngau-nhien!"
COMMERCIAL_LICENSE_SECRET="chuoi-ky-hmac-license-tt10-bi-mat"
COMMERCIAL_ADMIN_TOKEN="token-quan-tri-admin-bi-mat"
```

### B. Lệnh CLI dành cho Seller & Buyer
```bash
# 1. Kiểm tra sức khỏe toàn hệ thống (v4.1..v9.0 + v10CommercialReady)
node standalone/cli.mjs doctor

# 2. [Seller] Cấp mã bản quyền TT10 cho người mua
node standalone/cli.mjs license --plan PRO_AUTO_TRADER --days 30 --ref buyer@example.com

# 3. [Buyer / 0 API Key] Mô phỏng quét vốn & kích thước hợp đồng theo vốn thực
node standalone/cli.mjs commercial-sim --equity 1500 --exchange OKX --version v9 --tier SAFE_75WR

# 4. Mở Web Console thương mại tại http://127.0.0.1:4180 (mục Commercial SaaS Hub)
node standalone/cli.mjs serve
```

### C. Quy trình REST API End-to-End (Seller -> Buyer Onboarding -> Demo Auto-Trade)
1. **Seller cấp mã `TT10`:** `POST /api/commercial/admin/licenses` (header `x-admin-token: <COMMERCIAL_ADMIN_TOKEN>`, body `{ "planId": "PRO_AUTO_TRADER", "subscriberRef": "buyer@example.com", "durationDays": 30 }`).
2. **Buyer mô phỏng không cần Key:** `POST /api/commercial/simulate-scan` (`{ "equityUsdt": 5000, "exchange": "OKX", "version": "v9", "riskTier": "SAFE_75WR" }`).
3. **Buyer Onboarding & Mã hóa Key vào Vault AES-256-GCM:** `POST /api/commercial/subscribers/onboard` (kèm `licenseKey`, `apiKey`, `apiSecret`, `passphrase`, `rawPermissionPayload: { "perm": "read_only,trade" }`, `armingPin`, `simulated: true`, `executionMode: "SCAN_AND_SIGNAL_ONLY"`). Lưu lại `sessionToken` trả về duy nhất 1 lần.
4. **Buyer Quét Tài Khoản & Kích Hoạt Demo Auto-Trade:**
   - Quét số dư & sinh phiếu tín hiệu riêng: `POST /api/commercial/subscribers/scan` (header `x-subscriber-token: <sessionToken>`).
   - Bật chế độ tự động Demo: `POST /api/commercial/subscribers/mode` (`{ "executionMode": "DEMO_AUTO_TRADE", "armingPin": "..." }`).
   - Chạy chu kỳ đặt lệnh `post_only` + `oco reduceOnly`: `POST /api/commercial/subscribers/run-cycle` (`{ "armingPin": "..." }`).
   - Xem bảng điều khiển cá nhân: `GET /api/commercial/subscribers/dashboard` (header `x-subscriber-token`).
