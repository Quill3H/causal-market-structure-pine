# SMC Confirmed 1.3.0

Chỉ báo hỗ trợ đọc cấu trúc giá, Order Block (OB) và Fair Value Gap (FVG), sửa từ file `TOOL` của repo này. Mã gốc ghi tác giả BigBeluga và giấy phép MPL 2.0; bản bảo trì giữ nguyên ghi nhận đó.

## Cài trên TradingView

1. Mở Pine Editor, tạo **indicator mới**.
2. Chép toàn bộ nội dung `TOOL.pine` vào editor, lưu rồi chọn **Add to chart**.
3. Tên ngắn trên biểu đồ là **SMC Confirmed [1.3.0]**.
4. Muốn xem FVG, bật **Enable FVG** trong nhóm FAIR VALUE GAP.

`TOOL` là bản v5 cũ để đối chiếu. Dùng `TOOL.pine` cho bản sửa v6. Các thiết lập của bản cũ không tự chuyển sang script mới.

## Các thay đổi

### Bản 1.3.0: chế độ Cân bằng và trạng thái tín hiệu

Mặc định **Signal mode = Balanced**. Nến đã đóng, cấu trúc cùng hướng và từ chối OB còn hiệu lực từ nến trước vẫn bắt buộc. Năm kiểm tra bổ sung vẫn bật: Mapping, FVG chồng lấn, sweep/raid gần đây, RVOL xác nhận ≥ 1,2 và RVOL nguồn ≥ 1,0. Mỗi kiểm tra đạt đóng góp 1 điểm; cần ít nhất **2/5** để phát mũi tên. Đây là điểm đồng thuận, không phải xác suất, và chưa được tối ưu bằng kiểm tra hiệu quả dự báo.

Chọn **Strict** để yêu cầu tất cả kiểm tra đang bật như bản 1.2.1. Tắt một kiểm tra loại nó khỏi cả tử số và mẫu số; ngưỡng Balanced được chặn bằng số kiểm tra đang bật. Nếu tắt cả năm, chỉ còn điều kiện bắt buộc về cấu trúc/OB. Thiếu dữ liệu volume hoặc baseline bằng 0 vẫn chặn tín hiệu khi kiểm tra volume tương ứng đang bật; dữ liệu thiếu không được bù bằng điểm khác.

Mũi tên lớn hơn; có alert BUY/SELL chỉ sau nến đóng. **Show signal status** hiện chế độ, tổng tín hiệu trong toàn bộ lịch sử đã tính, thời điểm tín hiệu gần nhất theo múi giờ sàn, và trạng thái của nến đóng gần nhất: đang chờ từ chối OB, thiếu dữ liệu volume hoặc điểm đồng thuận chưa đạt. Các số tổng trên bảng có thể lớn hơn số mũi tên trong phần dữ liệu đang hiển thị/trả về; mỗi lần đổi dữ liệu hoặc thiết lập sẽ tính lại lịch sử.

Kiểm tra TradingView trên BINANCE:BTCUSDT 15 phút, cùng 1.252 hàng dữ liệu biểu đồ trả về: **Strict 0 BUY / 0 SELL; Balanced 5 BUY / 10 SELL**, cả năm kiểm tra đều bật. Mã chính biên dịch không cảnh báo. Bài kiểm tra gồm ngưỡng điểm, thiếu dữ liệu, selector Balanced và các điều kiện Strict cũ. Chi tiết/hash ở `tests/validation-1.3.0.json`. Kết quả chỉ chứng minh luồng phát/hiển thị tín hiệu, chưa đo tỷ lệ đúng hay lợi nhuận.

### Sửa ở bản 1.2.1 và kiểm tra BTC 15 phút

Sửa hai nhánh khởi tạo cấu trúc: lần phá giảm đầu tiên phải tạo OB giảm; lần phá tăng đầu tiên phải tạo OB tăng. Bản 1.2.0 đã gọi ngược hướng ở hai nhánh này. Bản sửa giữ nguyên toàn bộ điều kiện mũi tên.

Kiểm tra cuối trên TradingView ngày 07/11/2026, BINANCE:BTCUSDT 15 phút, cửa sổ trả về 400 nến: tất cả bộ lọc bật cho 0 BUY / 0 SELL; bộ cơ bản (cấu trúc, từ chối OB, RVOL xác nhận ≥ 1,2; tắt Mapping/FVG/sweep/RVOL nguồn) cho 1 BUY / 4 SELL. Tắt riêng một bộ lọc FVG, sweep hoặc Mapping vẫn cho 0 tín hiệu trong cửa sổ này. Mỗi lượt được đợi tính xong và kiểm tra mã/khung thời gian trước khi đếm. Các cấu hình này chỉ dùng để chẩn đoán trong tab thử nghiệm; không thay mặc định.

Vì vậy, không thấy mũi tên trong đoạn này không phải do không có lệnh vẽ: bộ điều kiện đầy đủ chưa có nến thỏa mãn. Kết quả đếm không đo tỷ lệ đúng, không chứng minh cấu hình ít bộ lọc tốt hơn. Xem `tests/validation-1.2.1.json` để biết phạm vi kiểm tra và hash mã.

### Mũi tên xác nhận

**BUY xanh dưới nến** báo một thiết lập thiên về tăng. **SELL đỏ trên nến** báo một thiết lập thiên về giảm. Mũi tên được vẽ ngay trên nến xác nhận sau khi nến đóng, không đặt lùi về nến nguồn và không xuất hiện trên nến còn chạy. Đây là hướng của thiết lập, không phải giá mục tiêu hoặc dự báo chắc chắn cho nến kế tiếp.

Trong chế độ **Strict**, cần đủ các dữ kiện sau cho chiều tăng; chiều giảm áp dụng đối xứng. **Balanced** luôn yêu cầu mục 2 và cấu trúc cùng hướng, rồi dùng Mapping cùng các mục 3–6 làm năm điểm hỗ trợ:

1. Cấu trúc thị trường và Mapping đều đang tăng.
2. Nến chạm một OB tăng còn hiệu lực, đã được tạo từ nến trước, rồi đóng vượt mép trên vùng. Breaker và vùng đã bị phá không được dùng làm OB thường.
3. Có FVG tăng còn hiệu lực từ nến trước chồng lấn OB. Nến xác nhận phải chạm phần giá chung và đóng vượt mép trên của cả hai vùng.
4. Trong 10 nến gần đây có quét đáy theo cấu trúc hoặc raid FVG tăng; chiều giảm dùng quét đỉnh/raid FVG giảm.
5. Volume nến xác nhận ít nhất bằng **1,2 lần** volume trung bình của **20 nến trước nó**.
6. Volume nến nguồn của OB ít nhất bằng **1 lần** trung bình của **20 nến trước nến nguồn**. Đây là RVOL nguồn được tính riêng, không so trực tiếp con số Source V tuyệt đối.

Mỗi OB phát tối đa một mũi tên. Nếu hai hướng cùng đủ điều kiện, chỉ báo không vẽ mũi tên để tránh tín hiệu mâu thuẫn. Khi bật bộ lọc volume, thiếu dữ liệu hoặc trung bình bằng 0 sẽ không phát tín hiệu theo bộ lọc đó.

Nhóm **CONFIRMED ARROWS** cho phép bật/tắt từng bộ lọc và thay các ngưỡng. Mặc định bật toàn bộ năm kiểm tra và dùng Balanced 2/5; vẫn có thể có đoạn không có nến đủ điều kiện. Strict giữ quy tắc tất cả cùng đạt. Các ngưỡng 1,2 / 1,0 / 20 / 10 là quy tắc ban đầu, chưa được tối ưu hay chứng minh làm tăng tỷ lệ đúng.

FVG và Mapping vẫn được tính để xét mũi tên dù bạn ẩn hình vẽ của chúng. Tắt **Show buy/sell arrows** chỉ ẩn mũi tên; không thay đổi quá trình tính và ghi nhận OB. Các tùy chọn tạo cấu trúc như Build Sweep và các chế độ mitigation vẫn ảnh hưởng dữ kiện được tạo ra.

### Các sửa lỗi từ bản 1.1.0

- Sửa xóa nhầm vùng chồng lấn; Recent/Old chọn vùng theo nến xác nhận. Khoảng giá bằng nhau hoàn toàn cũng được xử lý; hai vùng chỉ chạm mép không bị coi là chồng lấn.
- Xóa vùng bị phá từ cuối mảng về đầu, tránh bỏ sót nhiều vùng bị phá trên cùng một nến.
- Close chỉ so sánh giá đóng cửa. Wick dùng high/low của nến đã đóng; Avg dùng high/low vượt trung điểm vùng, giữ ý nghĩa cũ của chế độ này.
- Bỏ các thanh Buy/Sell Activity mô phỏng và phần trăm dễ gây hiểu nhầm. **Source V** là volume của nến nguồn dùng để dựng OB; thiếu dữ liệu sẽ hiện N/A. Nó không phải xác suất mua hoặc số liệu bên mua/bán chủ động.
- Chỉ cập nhật trạng thái cấu trúc, vùng giá, breaker và raid sau khi nến đóng. Hình vẽ ở nến đang chạy dùng trạng thái đã xác nhận.
- OB và FVG được vẽ bắt đầu ở nến phát hiện, không neo ngược về nến nguồn. Giá của OB vẫn lấy từ nến nguồn; FVG vẫn dùng cấu trúc ba nến. FVG xuất hiện khi nến thứ ba đóng, bỏ độ trễ thêm một nến của bản cũ.
- Pivot với độ dài 5 vẫn cần 5 nến bên phải để xác nhận; các đường cấu trúc có thể nối về cực trị đã xác nhận. Đây không phải tín hiệu đã biết ở thời điểm cực trị đó hình thành.
- Chuyển Pine v6, dùng điều kiện pivot rõ ràng, loại mã và kiểu dữ liệu không được sử dụng.

## Giới hạn lịch sử và hiển thị

Phép truy xuất lịch sử được chặn ở 4.500 nến. Khi mốc cũ hơn, phép tìm cực trị dùng phần dữ liệu còn nằm trong phạm vi này. Mỗi phía giữ tối đa 100 OB và 100 FVG; Mapping giữ tối đa 1.000 điểm. Đây là giới hạn lưu trữ, khác với số vùng đang hiển thị.

Mỗi phía hiển thị tối đa 20 OB, 20 FVG và 100 sự kiện cấu trúc để giữ số đối tượng trong giới hạn TradingView. Mặc định chỉ hiển thị 5 vùng mỗi phía. Bật tất cả ở mức tối đa có thể làm biểu đồ rối.

Window lọc phạm vi **hiển thị cấu trúc**, không khởi động lại thuật toán ở mỗi lần tải. Tính toán được gọi nhất quán trên các nến đã tải; các phép đọc lịch sử luôn có giới hạn. Tắt hiển thị OB vẫn duy trì việc loại bỏ vùng đã bị phá. Kết quả có thể khác bản cũ do các sửa đổi này, dữ liệu đầu vào hoặc điểm bắt đầu lịch sử.

Đây là công cụ đánh dấu cơ hội để bạn xem xét. Các mũi tên dùng bộ điều kiện được công bố; chưa có mô hình xác suất, quy tắc đặt lệnh hoặc tự động giao dịch.

## Kiểm tra

Kết quả mới nhất ở `tests/validation-1.3.0.json`. Kết quả bản 1.2.1 nằm trong `tests/validation-1.2.1.json`; `tests/validation.json` giữ kết quả bản 1.2.0. Lượt 1.2.1 chạy lại kiểm tra hướng OB đầu tiên ở cả hai chiều và kiểm tra mũi tên; không chạy lại toàn bộ bộ kiểm tra 1.2.0. Bản phát hành đã được gửi vào compiler TradingView Pine v6; compiler không báo lỗi hoặc cảnh báo cho `TOOL.pine`. Các harness dùng chính hàm được trích từ mã sản phẩm, với OHLC giả lập chỉ trong harness.

Tạo lại các script kiểm thử bằng Python 3 (thư viện chuẩn):

```powershell
python tests/build_regression.py
python tests/build_regression.py TOOL.pine Old
python tests/build_history_regression.py
python tests/build_signal_regression.py
python tests/build_initial_ob_regression.py bull
python tests/build_initial_ob_regression.py bear
```

Chạy từng file `tests/regression-*.pine` như một indicator riêng trong TradingView. Hai script recent/old phải hiện **REGRESSION PASS**; history phải hiện **HISTORY PASS** và cần hơn 4.500 nến đã tải; signals phải hiện **ARROWS PASS**. `runtime.error` sẽ chỉ ra kiểm tra không đạt. Cảnh báo shadowing OHLC trong harness là chủ đích để dùng dữ liệu cố định; mã sản phẩm không shadow các biến này.

Hai script initial quan sát hướng được yêu cầu trong lời gọi tạo OB tại lần phá cấu trúc đầu tiên. Chúng phải hiện **INITIAL BULL PASS** / **INITIAL BEAR PASS**; không kiểm tra khả năng tồn tại của vùng hay chất lượng dự báo. Cùng ca quan sát này đã thất bại trên mã 1.2.0 trước sửa ở cả hai chiều.

`tests/baseline.json` ghi nhận ví dụ kiểm thử lỗi trên bản gốc. Đính chính review ngày 03/11/2026: compiler TradingView ngày 04/11/2026 vẫn biên dịch được bản gốc; nhận định cũ rằng lời gọi `timeframe.change()` chắc chắn chặn biên dịch đã bị rút lại. Bản sửa bỏ điều kiện đổi timeframe không cần thiết vì FVG sử dụng ngay khung biểu đồ.

Các kiểm tra kỹ thuật không đánh giá tỷ lệ thắng, lợi nhuận hoặc hiệu quả dự báo. Chưa thực hiện một phiên Bar Replay đầy đủ hay kiểm tra realtime kéo dài.
