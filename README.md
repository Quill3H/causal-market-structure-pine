# SMC Confirmed 3.0.0 — Causal Market-Structure Signals with a Parity-Tested Simulation Harness

> **Research scope (English abstract)**
> This repository formalizes market-structure primitives (Order Blocks, Fair Value Gaps, sweeps, change of character) as a closed-bar, non-repainting Pine Script v6 indicator (`TOOL.pine`) with a companion Strategy Tester script (`TOOL_Strategy.pine`). It is a research and simulation tool; it does not place orders and makes no claim of live profitability.
>
> * **Causality:** `request.security` calls use `lookahead_off`, and signals, pivots and exits are evaluated on confirmed bars only.
> * **Conservative fill rules:** when a stop and a target are touched in the same bar the stop is counted first; gaps through a stop exit at the open. The same rules are implemented in `research/sim_engine.mjs` and in the Pine strategy.
> * **Automated verification:** Python generators in `tests/build_*.py` build Pine regression harnesses (`tests/regression-*.pine`), validated against JSON artifacts (`tests/validation-*.json`). Node.js checks (`tests/pine_static_check.mjs`, `tests/pine_parity.mjs`) compare the Pine logic bar by bar and trade by trade with the reference simulator.
> * **Validation design:** unseen holdout, a 6,000-bar TradingView window, 4-fold walk-forward and a prefix-truncation causality test, after fees and slippage. See `docs/EVALUATION_AND_RESEARCH_REPORT.md` for sensitivity tables and the history of failed iterations.
> * **Reading the results:** the reported win rate benefits from a breakeven-plus-cost exit (`BE+`); the no-BE sensitivity run is reported alongside it, and these figures are retrospective research results, not evidence of an executable edge.
> * **Attribution and license:** the original indicator is by **BigBeluga** under the Mozilla Public License 2.0; this repository retains that notice. Documentation below is in Vietnamese.

---

# SMC Confirmed [3.0.0]

Chỉ báo Smart Money Concepts (Pine Script v6) giữ nguyên toàn bộ phần sửa lỗi cấu trúc thị trường, Order Block (OB), Fair Value Gap (FVG), Sweep và Heatmap thanh lý ước tính tùy chọn, đồng thời nâng cấp động cơ tín hiệu mặc định **`SMC High-WinRate [v3.0]`** với mô phỏng **PAPER IN / OUT** khớp từng nến cùng `research/sim_engine.mjs`.

Mã nguồn gốc giữ ghi nhận tác giả **BigBeluga** theo giấy phép **Mozilla Public License 2.0 (MPL 2.0)**.

---

## Cài đặt nhanh trên TradingView

### 1. Chỉ báo `TOOL.pine` (`SMC Confirmed [3.0.0]`)
1. Mở TradingView → **Pine Editor** → tạo **Indicator mới**.
2. Dán toàn bộ nội dung file [TOOL.pine](TOOL.pine) vào Pine Editor.
3. Nhấn **Save** → **Add to chart**.
4. Tên hiển thị trên chart: **`SMC Confirmed [3.0.0]`**.
5. Để chế độ mặc định **Signal mode = `SMC High-WinRate [v3.0]`** và **Auto-tune v3.0 profile = ON**:
   - Trên khung **≤ 15m** (ví dụ `15m`): tự động chạy engine **15m `H1_CleanDisp_AtrExh`** (dùng nến `1H` đã đóng).
   - Trên khung **> 15m** (ví dụ `1h`): tự động chạy engine **1h `AdaptiveTrapPolarity`** (bẫy thanh khoản đa tầng `1H/4H/1D` + sổ ảo nhân quả BE/SL).
   - Hoạt động trên **mọi mã OHLC chuẩn** (`BTCUSDT`, `BTCUSDT.P`, Binance, Bybit, OKX, `ETHUSDT`, ...), không còn khóa cứng `BINANCE:BTCUSDT`.

### 2. Chiến lược đối chiếu `TOOL_Strategy.pine` (`SMC High-WinRate Strategy [3.0.0]`)
1. Mở **Pine Editor** → tạo **Strategy mới**.
2. Dán toàn bộ nội dung [TOOL_Strategy.pine](TOOL_Strategy.pine) → **Save** → **Add to chart**.
3. Mở tab **Strategy Tester** ở dưới màn hình để xem đường cong vốn, drawdown và danh sách lệnh khớp trực tiếp với phí hiệu dụng `0.075%/chiều` (`0.15%` khứ hồi = `0.10%` phí + `2 × 0.025%` trượt giá).

---

## Điểm mới chính ở phiên bản 3.0.0

- **Tỷ lệ thắng ròng ≥ 65% đã kiểm chứng trên cả 15m và 1h (BTCUSDT):** đạt đồng thời cả 4 cổng cứng (Unseen Holdout, cửa sổ 6.000 nến TradingView, 4-Fold Walk-Forward, và kiểm định nhân quả cắt tiền tố).
- **Vào lệnh Limit Pullback thay cho đuổi giá tại open kế tiếp:** giảm chi phí ma sát và cải thiện điểm vào (`0.55 × ATR14` ở 15m; `0.18 × ATR14` ở 1h), kèm đường chờ **LMT L / LMT S** và đếm ngược hết hạn (`6` nến).
- **Bảo vệ vị thế với Breakeven-Plus-Cost Ratchet (`BE+`):** chỉ đánh giá sau khi nến đóng (`barstate.isconfirmed`), dời SL lên dương phí+trượt giá (`+0.28%` ở 15m, `+0.34%` ở 1h) khi giá đóng đạt `+0.43R`, có hiệu lực từ nến kế tiếp.
- **Quy tắc khớp lệnh bảo thủ 100% đồng nhất với `research/sim_engine.mjs`:**
  - Chạm cả SL/BE và TP trong cùng một nến → **luôn tính SL/BE thua/hòa trước**.
  - Gap qua SL → thoát tại `open`; gap qua TP → chỉ lấy mức `target`.
  - Ở chính nến khớp Limit (không gap qua TP), chỉ công nhận TP nếu `close` vượt qua `target`.
- **Nhãn & cảnh báo đầy đủ:** `IN L`, `IN S`, `OUT TP`, `OUT BE`, `OUT SL`, `OUT T`, đường **Limit / SL / BE+ / TP** trên chart, và alert cho từng sự kiện.
- **Bảng điểm gọn góc trên bên phải:**
  `Thắng XX.X% (W) | Thua YY.Y% (L) | N=... | PF=... | Net +Z.ZZ%`
- **Thu gọn plot & chuẩn Pine v6 nghiêm ngặt:** tổng cộng **28 plot calls** (dưới ngưỡng mục tiêu 55 và trần 64 của TradingView), toàn bộ `ta.*` và `request.security(..., lookahead = barmerge.lookahead_off)` nằm ở top-level vô điều kiện.

---

## Tóm tắt kết quả kiểm chứng (sau phí 0.10% + trượt giá 0.025%/chiều)

| Khung BTCUSDT | Engine v3.0 | Unseen Holdout (25% cuối) | TV 6.000 nến | Walk-Forward 4 Fold | ETHUSDT đối chứng |
|---|---|---|---|---|---|
| **15m** | `H1_CleanDisp_AtrExh` | **73.53%** (50/68) · PF **1.486** · TB **+0.151%** | **68.89%** (31/45) · PF **1.319** · TB **+0.117%** | **74.57%** (217/291) · PF **1.516** | 63.09% (94/149) · PF 0.832 |
| **1h** | `AdaptiveTrapPolarity` | **74.51%** (38/51) · PF **1.396** · TB **+0.199%** | **75.00%** (51/68) · PF **1.533** · TB **+0.257%** | Anchored: **74.64%** (103/138) · PF **1.296** \| 4-Qtr: **78.77%** (141/179) · PF **1.643** | **69.14%** (56/81) · PF **1.057** · TB **+0.051%** |

> **Lưu ý minh bạch:** Tỷ lệ thắng cao ở cả 15m và 1h đạt được có đóng góp quan trọng từ cơ chế chốt **BE+** sau chi phí (`OUT BE` là lệnh dương ròng nhỏ). Khi tắt hoàn toàn BE+ (`noBE`), tỷ suất lợi nhuận trung bình vẫn dương trên 15m 12 tháng (`+0.204%/lệnh`, PF `1.390`) với win rate `57.09%`. Chi tiết phân tích đầy đủ, bảng độ nhạy và lịch sử các vòng thử nghiệm thất bại xem tại [docs/EVALUATION_AND_RESEARCH_REPORT.md](docs/EVALUATION_AND_RESEARCH_REPORT.md).

---

## Kiểm tra tự động (Node.js ≥ 20)

```bash
# Kiểm tra tĩnh Pine v6 (phiên bản, plot <= 55/64, lookahead_off, top-level ta.*, không khóa mã)
node tests/pine_static_check.mjs

# Kiểm chứng parity từng nến và từng lệnh trên toàn bộ 6 tập dữ liệu (15m & 1h)
node tests/pine_parity.mjs

# Chạy toàn bộ test suite
node --test research/sim_engine.test.mjs research/signals_15m.test.mjs research/signals_1h.test.mjs tests/pine_parity.test.mjs
```

## Tài liệu & Cấu trúc chính

- [TOOL.pine](TOOL.pine) — Indicator `SMC Confirmed [3.0.0]`
- [TOOL_Strategy.pine](TOOL_Strategy.pine) — Companion Strategy Tester `SMC High-WinRate Strategy [3.0.0]`
- [docs/EVALUATION_AND_RESEARCH_REPORT.md](docs/EVALUATION_AND_RESEARCH_REPORT.md) — Báo cáo đánh giá các phiên bản cũ, nguyên nhân thất bại và nghiên cứu v3.0.0
- [research/sim_engine.mjs](research/sim_engine.mjs) — Engine mô phỏng khớp lệnh chuẩn Pine parity
- [research/signals_15m.mjs](research/signals_15m.mjs) & [research/signals_1h.mjs](research/signals_1h.mjs) — Bộ sinh tín hiệu nhân quả 15m và 1h
- [tests/pine_static_check.mjs](tests/pine_static_check.mjs) & [tests/pine_parity.mjs](tests/pine_parity.mjs) — Bộ kiểm tra tĩnh & đối chiếu parity
