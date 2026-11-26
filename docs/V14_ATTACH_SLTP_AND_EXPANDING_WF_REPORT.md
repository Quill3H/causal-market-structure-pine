# Báo Cáo Kỹ Thuật SMC v14.0: Khớp Lệnh Bảo Vệ SL/TP Thực Tế (OKX `attachAlgoOrds` & Binance Fill-Watcher) và Tái Huấn Luyện Expanding Walk-Forward 6 Epoch

> [!NOTE]
> **Phạm vi nâng cấp v14.0:** Giải quyết hai khoảng trống thực chiến lớn nhất sau đợt kiểm định bảo mật `v13.0`: (1) Đồng bộ cơ chế đặt SL/TP bảo vệ thực tế trên sàn OKX V5 Swap & Binance USD-M Futures khi lệnh limit `post_only` / `LIMIT_GTX` chưa khớp (`position = 0`), và (2) Chuyển mô hình ML Crypto 5 năm từ huấn luyện tĩnh một lần (`v9.0`) sang **tái huấn luyện giãn nở ngoài mẫu hoàn toàn 6 epoch (`v14.0`)** kèm cổng đứng ngoài (`CV AUC >= 0.52`).

---

## Phần 1: Sửa Lỗi Đặt SL/TP Trước Khi Khớp Lệnh Trên Sàn Thật (Track 1A & 1B)

### 1.1. Nguyên nhân gốc rễ trên API sàn thật
Trước `v14.0`, bộ định tuyến lệnh đặt một lệnh chờ `post_only` (`LIMIT_GTX`) và lập tức gọi tiếp endpoint đặt lệnh dừng lỗ/chốt lời `reduceOnly: true`:
- **Trên OKX V5 Swap:** `POST /api/v5/trade/order-algo` từ chối lệnh `oco` có `reduceOnly: true` nếu lệnh limit vào vị thế còn nằm trên sổ lệnh chưa khớp (`position size = 0`).
- **Trên Binance USD-M Futures:** `POST /fapi/v1/order` (`STOP_MARKET` / `TAKE_PROFIT_MARKET` với `reduceOnly: true`) trả lỗi `-2022 ReduceOnly Order is rejected` nếu chưa có vị thế mở tương ứng.

### 1.2. Kiến trúc xử lý mới trên OKX (`attachAlgoOrds`)
- **`standalone/exchange_okx.mjs`:**
  - Hàm `buildPostOnlyEntryOrder` nhận thêm `attachAlgoOrds`, `slTriggerPx`, `tpTriggerPx`, và `attachAlgoClOrdId`. Khi các tham số đính kèm được bỏ qua, payload giữ nguyên y hệt chuẩn cũ; khi `slTriggerPx` hoặc `tpTriggerPx` hợp lệ (`> 0`), hàm gắn trực tiếp `attachAlgoOrds: [{ attachAlgoClOrdId, slTriggerPx, slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx, tpTriggerPxType: 'last', tpOrdPx: '-1' }]` vào lệnh `post_only`.
  - Mọi `OkxClient` thật mang cờ `supportsAttachAlgoOrds = true` và hỗ trợ `getPendingAlgoOrders({ instType, ordType, symbol })` qua `GET /api/v5/trade/orders-algo-pending`.
- **`standalone/commercial_engine.mjs` & `standalone/order_router.mjs`:**
  - Khi `sub.exchange === 'OKX'` và `client.supportsAttachAlgoOrds === true`, `runSubscriberAutoTradeCycle` tính trước `slClOrdId` (`leg: 'O'`) và gửi cả entry + SL/TP trong **1 request duy nhất** `POST /api/v5/trade/order`.
  - Bảng `subscriber_orders` ghi dòng con với `orderType: 'oco_attached'`, `status: 'ATTACHED_TO_ENTRY'`, action `SL_TP_ATTACHED_TO_ENTRY` (không gửi yêu cầu `/trade/order-algo` thứ hai gây lỗi pre-fill).
  - Trong `StandaloneOrderRouter.routeTransition`, cờ tùy chọn `attachSlTpOnEntry = false` giữ mặc định tương thích ngược cho kiểm thử cũ, và cho phép gộp `attachAlgoOrds` (`leg: 'A'`) khi bật `attachSlTpOnEntry: true`.
  - Các mock kiểm thử thuần (`!client.supportsAttachAlgoOrds`) vẫn đi qua nhánh `placeReduceOnlySlTp` độc lập có bọc `try/catch` riêng.

### 1.3. Kiến trúc Position-Aware Fill Watcher trên Binance (`PENDING_FILL_WATCH -> PROTECTIVE_SL_TP_SYNCED`)
- **`standalone/exchange_binance.mjs`:**
  - Bổ sung `getOrder({ symbol, orderId, origClientOrderId })` (`GET /fapi/v1/order`), `getOpenOrders({ symbol })` (`GET /fapi/v1/openOrders`), và hàm thuần `hasBinanceProtectiveSlTp({ openOrders, symbol, entrySide })` trả về `{ hasSl, hasTp, fullyProtected }`.
- **`standalone/commercial_engine.mjs` & `standalone/order_router.mjs`:**
  - Khi `sub.exchange === 'BINANCE'` và `deferSlTpUntilFill === true` (mặc định bật trên mọi thực thể `BinanceFuturesClient`) trong lúc `!openPosSymbols.has(...)` (`position = 0`): không bắn lệnh `reduceOnly` trước khi khớp; ghi `status: 'PENDING_FILL_WATCH'` kèm action `SL_TP_DEFERRED_UNTIL_FILL`.
  - Ngay sau Guardrail 6 ở mỗi chu kỳ quét (`_reconcileOpenPositionProtection`), hệ thống duyệt toàn bộ vị thế đang mở khác `0` trong `scan.openPositions`, đối chiếu `getOpenOrders` / `hasBinanceProtectiveSlTp` (hoặc `getPendingAlgoOrders` trên OKX). Khi phát hiện lệnh chờ đã khớp hoặc vị thế chưa có bảo vệ, engine lập tức gọi `placeReduceOnlySlTp` theo **đúng khối lượng khớp thực tế** (`Math.min(Math.abs(posQty), watchQty)` làm tròn chuẩn `stepSize`), cập nhật log thành `SUBMITTED` và trả về `PROTECTIVE_SL_TP_SYNCED`.
  - `StandaloneOrderRouter.syncFilledPositionProtection` cung cấp cơ chế đồng bộ tương đương cho chế độ single-tenant (`leg: 'F'`, trả về `PROTECTIVE_SL_TP_SYNCED` / `ALREADY_PROTECTED` / `NO_OPEN_POSITION`).

### 1.4. Đồng bộ hủy lệnh con & Giữ nguyên bảo vệ vị thế đang mở
- Khi quá hạn lệnh chờ (`CANCELLED_STALE`) hoặc khi người dùng bấm Tạm dừng / Dừng ngay (`AutopilotScheduler.disarmSubscriber` với `cancelPendingEntries: true`), mọi bản ghi con ở trạng thái `ATTACHED_TO_ENTRY` (`SL_TP_ATTACHED_CANCELLED`) hoặc `PENDING_FILL_WATCH` (`SL_TP_WATCH_CANCELLED`) gắn với lệnh entry cha chưa khớp sẽ được chuyển thành `CANCELLED`.
- Các lệnh bảo vệ `oco_reduce_only` / `SL_TP_REDUCE_ONLY` đang `SUBMITTED` cho vị thế thực tế đã khớp vẫn được **giữ nguyên hoàn toàn** trên sàn.

---

## Phần 2: Kiến Trúc Tái Huấn Luyện Expanding Walk-Forward `v14.0` (Track 2A & 2B)

### 2.1. Khắc phục giới hạn Single Cal-Fit của `v9.0`
Phiên bản `v9.0` huấn luyện mô hình ML một lần trên phần Cal cố định và sàng lọc theo 3 lát cắt `Cal/Val`. Ngược lại, **`v14.0`** (`research/train_v14_expanding_wf.py` + `research/expanding_wf_v14.mjs`) thực thi tái huấn luyện giãn nở hoàn toàn ngoài mẫu qua thời gian:
- **Chia 6 epoch giãn nở + PreEpoch + LiveActive:**
  - `PreEpoch [20%..40%)`: huấn luyện trên `[0%..20%)`.
  - `Epochs 0..5 [40%..100%]`: mỗi epoch chiếm ~10% (~6 tháng) trên dữ liệu lịch sử 5 năm; mô hình cho epoch `k` chỉ được phép học trên các giao dịch đóng hoàn toàn trước mốc bắt đầu epoch `T_k` (`maxTrainExitTime <= epochStartTimeSec` và `maxTrainExitIndex < epochStartBarIndex`, 0 giao dịch vắt qua biên trên toàn bộ `64/64` cửa sổ stream-epoch).
  - `LiveActiveModel`: huấn luyện giãn nở tới mốc cuối cùng để suy luận cho dữ liệu mới `t >= lastEpochEndTimeSec`.
- **Cố định ranh giới UTC Timestamp:** Toàn bộ `epochStartTimeSec`, `epochEndTimeSec` được khóa cứng trong `research/results_v14/models_v14_expanding_wf.json` (SHA-256 Lock: `d91242fcea520d4a338e4d03368457c35079606d53af687e5410f63c2b1e1622`), đảm bảo cắt tiền tố hay thêm nến live ở cuối chuỗi không bao giờ làm dịch epoch chấm điểm của bất kỳ nến quá khứ nào.
- **Trọng số suy giảm & Cổng đứng ngoài (`Abstention Gate`):** Áp dụng trọng số hàm mũ theo thời gian gần đây (`half-life = 365 days`), tách Inner-Cal (`75%`) / Inner-Val (`25%`) có purge, và tự động đứng ngoài giữ tiền mặt (`abstain: true`, phát `0` lệnh) nếu mô hình epoch không đạt đồng thời `chronoCvAuc >= 0.52`, `tau >= 0.52`, `innerValTrades >= 4`, `innerValNetPct > 0`, và `innerValPf >= 1.05`. Tỉ lệ đứng ngoài là `1/48` epoch chính (`2.08%`, tại `BTC_15m Epoch 5`), cộng thêm `BTC_15m LiveActiveModel`, `BNB_1h PreEpoch`, và `SOL_15m PreEpoch` (`4/64` tổng cửa sổ).

### 2.2. Đối chiếu Portfolio `v14.0` vs `v9.0` (100% số liệu trích từ JSON đã khóa, `Liq = 0` trên cả 61 tháng UTC)

| Gói Portfolio (`EXCHANGE_POST_ONLY` / `STRICT_TAKER`) | Pure OOS `[40%..100%]` | Blind Holdout Y5 (`13m`, `[80%..100%]`) | Full 5Y (`61m`) | MaxDD Full 5Y | Worst Month | Ghi chú so với `v9.0` |
| :--- | :--- | :--- | :--- | :---: | :---: | :--- |
| **`SAFE_V14`** (`lev=0.55, maxLev=6`) | **+136,11%** (`67,78% WR`, `PF 1,17`, `+2,98%/mo`, `CAGR +33,05%`, `Sharpe 1,04`) | **-24,89%** (`n=263, 64,64% WR, PF 0,87, -1,94%/mo`, Taker `-30,08%`) | **+222,96%** (`n=942, 68,26% WR, PF 1,21, +2,39%/mo`, Taker `+88,09%`) | **25,37%** (Y5 `25,07%`) | **-13,26%** (Y5 `-13,10%`) | Giảm Blind Y5 từ `-33,91% -> -24,89%` và cắt đôi MaxDD 5Y (`46,89% -> 25,37%`) |
| **`BALANCED_V14`** (`lev=0.90, maxLev=8`) | **+289,78%** (`67,78% WR, PF 1,19, +5,31%/mo, CAGR +57,18%`) | **-32,09%** (`PF 0,90, -2,36%/mo`, Taker `-41,27%`) | **+476,52%** (`PF 1,22, +3,98%/mo, CAGR +41,82%`, Taker `+96,25%`) | **35,75%** (Y5 `35,74%`) | **-20,80%** | Giảm Blind Y5 từ `-57,36% -> -32,09%` và MaxDD 5Y (`68,18% -> 35,75%`) |
| **`MAXIMIZED_V14`** (`lev=2.10, maxLev=10`) | **+359,22%** (`67,59% WR, PF 1,16, +11,27%/mo, CAGR +65,98%`) | **-65,57%** (`64,50% WR, PF 0,90, -5,27%/mo`, Taker `-78,89%`) | **+1.073,53%** (`68,09% WR, PF 1,20, +9,07%/mo`, Taker `+46,19%`) | **70,16%** (Y5 `65,89%`) | **-44,39%** | Giảm Blind Y5 từ `-81,76% -> -65,57%` và MaxDD 5Y (`86,57% -> 70,16%`) |
| **`CROSS_ASSET_ALL_WEATHER_V14`** (`v14 Crypto + ES=F/NQ=F v8`) | 2Y Overlap: **+283,08%** (`n=804, 68,53% WR, PF 1,21, +6,27%/mo, CAGR +75,70%, Sharpe 1,38, Calmar 2,04`) | **-22,80%** (`n=305, 66,23% WR, PF 0,94, -1,32%/mo`) | `FuturesOnly 2Y`: **+39,51%** (`76,74% WR, PF 1,73, DD 12,30%`) | **37,12%** | **-22,84%** | Tốt hơn rõ rệt mức `v9` Y5 Overlap (`-32,77%`, DD `51,01%`) |

> **Nhận xét trung thực về trade-off `v14.0` vs `v9.0`:**
> Do toàn bộ lệnh `[20%..100%]` của `v14.0` được chấm điểm hoàn toàn ngoài mẫu trên các epoch ngắn với trọng số suy giảm bán rã 365 ngày và cổng đứng ngoài `CV AUC >= 0.52`, tổng lợi nhuận ghép lãi 5 năm của `v14.0` (`+222,96%` ở `SAFE_V14`) thấp hơn mức `+6.867,89%` của `v9.0 SAFE_V9`. Đổi lại, `v14.0` cắt mạnh rủi ro sụt giảm 5 năm (`25,37%` vs `46,89%`), thu hẹp tháng tệ nhất (`-13,26%` vs `-19,79%`) và giảm tổn thất mùa gấu Blind Holdout Y5 trên cả ba tier cũng như bản Taker (`-30,08%` vs `-45,15%`).

### 2.3. Chi tiết 8 Stream Crypto `v14.0` (`EXCHANGE_POST_ONLY`, trích từ `expanding_wf_v14_crypto_5y.json`)

| Stream | Active Epochs (`liveActive`) | Blind Y5 ML (`Comp / WR / PF`) | Blind Y5 Baseline (`Comp`) | OOS60 `[40..100%]` (`Comp / WR / PF`) | Full 5Y (`Comp / WR / PF`) |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **`SOL_1h`** | `6/6` (`true`) | **+13,54%** (`n=106, 68,87% WR, PF 1,13`) | +41,91% (`n=134`) | **+272,47%** (`n=255, 68,24% WR, PF 1,40`) | **+255,05%** (`n=258, 67,83% WR, PF 1,38`) |
| **`ETH_15m`** | `6/6` (`true`) | **+2,13%** (`n=5, 80,00% WR, PF 1,70`) | -11,19% (`n=33`) | -3,66% (`n=57, 70,18% WR, PF 0,99`) | **+18,49%** (`n=88, 72,73% WR, PF 1,21`) |
| **`BTC_1h`** | `6/6` (`true`) | **+1,01%** (`n=51, 66,67% WR, PF 1,06`) | -5,86% (`n=63`) | **+6,33%** (`n=139, 66,91% WR, PF 1,08`) | **+6,33%** (`n=139, 66,91% WR, PF 1,08`) |
| **`BNB_1h`** | `6/6` (`true`) | -0,46% (`n=22, 63,64% WR, PF 1,02`) | +0,12% (`n=24`) | **+5,98%** (`n=67, 67,16% WR, PF 1,11`) | **+5,98%** (`n=67, 67,16% WR, PF 1,11`) |
| **`SOL_15m`** | `6/6` (`true`) | -4,75% (`n=28, 64,29% WR, PF 0,92`) | -6,82% (`n=59`) | **+2,61%** (`n=99, 69,70% WR, PF 1,07`) | **+2,61%** (`n=99, 69,70% WR, PF 1,07`) |
| **`BNB_15m`** | `6/6` (`true`) | -8,98% (`n=12, 50,00% WR, PF 0,56`) | -8,29% (`n=31`) | **+7,53%** (`n=82, 67,07% WR, PF 1,12`) | **+7,96%** (`n=83, 67,47% WR, PF 1,12`) |
| **`ETH_1h`** | `6/6` (`true`) | -12,58% (`n=9, 44,44% WR, PF 0,34`) | -10,63% (`n=47`) | **+23,41%** (`n=81, 62,96% WR, PF 1,20`) | **+44,48%** (`n=93, 65,59% WR, PF 1,29`) |
| **`BTC_15m`** | `5/6` (`false`, đứng ngoài Epoch 5 & Live) | -28,19% (`n=30, 56,67% WR, PF 0,46`) | -37,55% (`n=68`) | **+5,99%** (`n=89, 69,66% WR, PF 1,10`) | **+33,12%** (`n=115, 69,57% WR, PF 1,25`) |

- `7/8` stream dương trên `OOS60` và **`8/8` stream dương trên toàn bộ 5 năm** (`BTC_15m` giảm lỗ Y5 từ `-37,55%` xuống `-28,19%` nhờ đứng ngoài hoàn toàn ở `Epoch 5`).
- **Kiểm định nhân quả & Parity (`research/expanding_wf_v14.mjs`):** `Lock SHA-256` PASS, `64/64` ranh giới purge & cổng đứng ngoài PASS, `0` sai lệch nhân quả khi cắt `72%` tiền tố hay đảo nến tương lai trên cả `8` stream, và sai số `sklearn` vs `predictProbaV5` Pure-JS trên toàn bộ `60` mô hình active đạt **`max_abs_diff = 1.110e-16 < 1e-12`**.

### 2.4. Sử dụng `v14.0` trong Runtime & CLI
Mặc định `version: 'auto'` tiếp tục giữ tương thích với `v5..v13`; người dùng có thể chỉ định tường minh `v14` qua biến môi trường `STRAT_VERSION=v14`, query `?version=v14`, hoặc CLI:

```bash
# Chạy backtest & portfolio theo mô hình Expanding Walk-Forward v14.0
node standalone/cli.mjs backtest --version v14 --symbol BTCUSDT.P --timeframe 1h --profile EXCHANGE_POST_ONLY
node standalone/cli.mjs portfolio --version v14 --tier SAFE_75WR --profile EXCHANGE_POST_ONLY

# Xem bảng đối chiếu đầy đủ v1.4 -> v14.0
node standalone/cli.mjs versions
```
