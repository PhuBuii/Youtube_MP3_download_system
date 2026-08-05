# Hướng dẫn kỹ thuật dự án PB Media Fetch

Tài liệu này giải thích dự án theo hướng dành cho người mới lập trình web: đọc để hiểu dự án đang làm gì, mỗi thư mục dùng để làm gì, từng feature chạy qua những file nào, và các function/class chính có trách nhiệm gì. Nếu cần làm lại dự án từ đầu, hãy đọc theo thứ tự từ trên xuống dưới.

## 1. Dự án này là gì?

PB Media Fetch là một web app tìm kiếm video YouTube, lấy danh sách định dạng có thể tải, rồi tải MP3/MP4 về máy người dùng.

Điểm quan trọng: app không bắt backend tải file về server. Backend chỉ hỏi YouTube bằng `yt-dlp` để lấy metadata và direct stream URL. File media được browser tải qua Cloudflare Worker proxy, sau đó FFmpeg.wasm trong browser chuyển mã nếu cần.

Luồng tổng quát:

```text
Người dùng
  -> Frontend React
  -> Backend FastAPI lấy metadata/direct stream URL bằng yt-dlp
  -> Frontend dùng Cloudflare Worker để fetch stream
  -> Web Worker chạy FFmpeg.wasm để tạo MP3/MP4
  -> Browser tải file về máy
```

## 2. Kiến thức nền cần biết

### Frontend

Frontend là phần chạy trong browser. Dự án dùng:

- `React`: xây giao diện bằng component.
- `TypeScript`: JavaScript có kiểu dữ liệu rõ hơn.
- `Vite`: dev server và build tool cho frontend.
- `Tailwind CSS`: viết CSS nhanh bằng class utility.
- `Web Worker`: chạy tác vụ nặng ở luồng riêng để UI không bị đơ.
- `FFmpeg.wasm`: bản FFmpeg chạy trong browser, dùng để chuyển mã audio/video.

### Backend

Backend là API server. Dự án dùng:

- `FastAPI`: framework Python để viết API.
- `Pydantic`: định nghĩa schema dữ liệu request/response.
- `yt-dlp`: thư viện lấy thông tin video, format, direct stream URL từ YouTube.
- `CORS`: cấu hình cho phép frontend gọi backend từ domain khác.

### Cloudflare Worker

Browser thường không thể fetch trực tiếp nhiều direct URL của YouTube vì CORS. Cloudflare Worker đứng giữa:

- Nhận URL stream từ frontend.
- Kiểm tra URL có thuộc host được phép không.
- Gọi upstream stream.
- Trả dữ liệu về browser kèm header CORS.

## 3. Cấu trúc thư mục

```text
.
├─ backend/
│  ├─ app/
│  │  ├─ main.py
│  │  ├─ config.py
│  │  ├─ schemas.py
│  │  └─ youtube.py
│  ├─ tests/
│  ├─ Dockerfile
│  └─ requirements.txt
├─ cloudflare-worker/
│  ├─ worker.js
│  ├─ tests/
│  ├─ package.json
│  └─ wrangler.toml
├─ frontend/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ api.ts
│  │  ├─ download.ts
│  │  ├─ main.tsx
│  │  ├─ types.ts
│  │  ├─ utils.ts
│  │  └─ workers/transcode.worker.ts
│  ├─ public/
│  │  └─ ffmpeg/
│  ├─ tests/
│  ├─ vite.config.ts
│  └─ package.json
├─ package.json
├─ README.md
└─ HUONG_DAN_KY_THUAT_DU_AN.md
```

## 4. Các feature chính

### Feature 1: Tìm kiếm video

Người dùng nhập từ khóa hoặc URL YouTube vào ô search.

Luồng chạy:

```text
App.tsx handleSearch()
  -> api.ts searchVideos()
  -> GET /api/search
  -> main.py search()
  -> YoutubeService.search()
  -> yt-dlp trả kết quả
  -> frontend render danh sách video
```

Nếu input là URL, backend kiểm tra URL có thuộc YouTube không. Nếu input là từ khóa, backend dùng cú pháp `ytsearch{limit}:keyword`.

### Feature 2: Xem định dạng tải được

Khi người dùng chọn một video, frontend gọi metadata.

Luồng chạy:

```text
App.tsx open video modal
  -> api.ts getMetadata()
  -> GET /api/metadata
  -> main.py metadata()
  -> YoutubeService.metadata()
  -> YoutubeService._metadata_response()
  -> frontend hiển thị audio_formats và video_formats
```

Backend chia format thành:

- `audio_formats`: stream chỉ có âm thanh.
- `video_formats`: stream có hình ảnh.

Sau đó frontend biến `FormatItem` thành `DownloadChoice` để người dùng chọn.

### Feature 3: Thêm job vào hàng đợi

Người dùng chọn video và định dạng, rồi bấm thêm vào hàng đợi.

Luồng chạy:

```text
App.tsx addJob()
  -> tạo CartJob
  -> setJobs()
  -> saveJobs()
  -> localStorage lưu queue
```

Job ban đầu có trạng thái `queued`, progress `0`, phase `metadata`.

### Feature 4: Chạy hàng đợi tải

Người dùng bấm bắt đầu. App sẽ xử lý từng job theo số worker được đề xuất.

Luồng chạy:

```text
startQueue()
  -> pumpQueue()
  -> runJob()
  -> extractStream()
  -> transcodeJob() hoặc downloadOriginalJob()
```

Nếu bật tải file gốc, app bỏ qua FFmpeg để tải stream trực tiếp. Nếu không, app dùng FFmpeg.wasm để tạo MP3/MP4 đúng lựa chọn.

### Feature 5: Lấy direct stream URL

Mỗi job trước khi tải đều gọi backend để lấy direct stream URL mới.

Luồng chạy:

```text
App.tsx runJob()
  -> api.ts extractStream()
  -> GET /api/extract-stream
  -> main.py extract_stream()
  -> YoutubeService.extract_stream()
  -> YoutubeService._select_streams()
```

Lý do phải lấy mới: direct URL của YouTube thường hết hạn nhanh. Không nên lưu URL này lâu rồi tái sử dụng.

### Feature 6: Chuyển mã bằng FFmpeg.wasm

Khi job cần MP3/MP4 đã xử lý, frontend tạo Web Worker.

Luồng chạy:

```text
App.tsx transcodeJob()
  -> tạo workers/transcode.worker.ts
  -> worker ensureLoaded()
  -> worker fetchStream()
  -> ffmpeg.writeFile()
  -> ffmpeg.exec()
  -> ffmpeg.readFile()
  -> postMessage DONE
  -> App.tsx tạo Blob URL
  -> triggerBrowserDownload()
```

Worker gửi progress nhiều giai đoạn: `init`, `download`, `write`, `transcode`, `package`.

### Feature 7: Tải file gốc

Nếu người dùng bật tùy chọn tải file gốc, app không dùng FFmpeg.

Luồng chạy:

```text
runJob()
  -> downloadOriginalJob()
  -> fetchStreamBlob()
  -> readResponseBlobWithProgress()
  -> tạo Blob URL
  -> triggerBrowserDownload()
```

Ưu điểm là nhanh hơn và ít tốn CPU/RAM. Nhược điểm là file có thể là `m4a`, `webm`, hoặc stream gốc, không nhất thiết đúng MP3/MP4 như người dùng mong muốn.

### Feature 8: Fallback khi FFmpeg lỗi

Nếu worker FFmpeg lỗi, app không bỏ job ngay. Nó chuyển qua tải stream gốc.

Luồng chạy:

```text
transcodeJob()
  -> worker gửi ERROR
  -> fallbackOriginal()
  -> downloadOriginalJob()
```

Feature này giúp người dùng vẫn nhận được file media khi browser yếu, thiếu COOP/COEP, hoặc FFmpeg.wasm không khởi tạo được.

### Feature 9: Diagnostics

Diagnostics giúp kiểm tra môi trường runtime.

Các mục kiểm tra:

- API base URL.
- CORS Worker URL.
- `window.crossOriginIsolated`.
- Backend `/health`.
- File `/ffmpeg/ffmpeg-core.wasm`.
- Worker CORS proxy.

Luồng chạy:

```text
DiagnosticsPanel
  -> runDiagnostics()
  -> checkBackendHealth()
  -> checkAssetDiagnostic()
  -> checkWorkerDiagnostic()
```

### Feature 10: Rate limit và bảo vệ URL

Backend giới hạn số request theo IP và chỉ nhận URL YouTube.

Luồng chạy:

```text
FastAPI Depends(enforce_rate_limit)
  -> client_key()
  -> request_log

validate_youtube_url()
  -> urlparse()
  -> kiểm tra scheme và hostname
```

Mục tiêu là giảm lạm dụng API và tránh biến server thành proxy tùy ý cho mọi URL.

## 5. Backend chi tiết

### `backend/app/config.py`

#### `class Settings`

Đây là class cấu hình app. Nó đọc biến môi trường hoặc dùng giá trị mặc định.

Các field chính:

- `frontend_origins`: danh sách frontend domain được phép gọi backend.
- `ytdlp_player_client`: player client cũ, dùng làm fallback.
- `ytdlp_player_clients`: danh sách player client cho yt-dlp, ví dụ `web,mweb,ios,android`.
- `ytdlp_pot_provider`: provider hỗ trợ PO token, mặc định `bgutil`.
- `ytdlp_bgutil_base_url`: địa chỉ service bgutil nếu dùng.
- `ytdlp_socket_timeout`: timeout khi yt-dlp kết nối.
- `rate_limit_window_seconds`: cửa sổ thời gian rate limit.
- `rate_limit_max_requests`: số request tối đa trong cửa sổ đó.

#### `Settings.origins`

Chuyển chuỗi `frontend_origins` thành list.

Ví dụ:

```text
"http://127.0.0.1:5173,http://localhost:5173"
-> ["http://127.0.0.1:5173", "http://localhost:5173"]
```

#### `Settings.player_clients`

Chuyển chuỗi player clients thành list cho yt-dlp.

#### `get_settings()`

Tạo và cache object `Settings`. `@lru_cache` giúp app không phải đọc cấu hình lại nhiều lần.

### `backend/app/schemas.py`

File này định nghĩa dữ liệu API trả về. Người mới nên hiểu đây là “hợp đồng” giữa backend và frontend.

#### `SearchItem`

Một kết quả tìm kiếm:

- `id`: video id.
- `url`: URL video.
- `title`: tiêu đề.
- `thumbnail`: ảnh đại diện.
- `duration`: thời lượng giây.
- `channel`: tên kênh.

#### `SearchResponse`

Response của `/api/search`, gồm `results: list[SearchItem]`.

#### `ErrorDetail`

Format lỗi thống nhất:

- `code`: mã lỗi máy đọc được.
- `message`: thông báo cho người dùng.
- `hint`: gợi ý xử lý.

#### `FormatItem`

Một định dạng media mà YouTube cung cấp:

- `format_id`: mã format của yt-dlp.
- `label`: nhãn hiển thị, ví dụ `128kbps` hoặc `720p`.
- `ext`: đuôi file.
- `type`: `audio` hoặc `video`.
- `abr`: audio bitrate.
- `vbr`: video bitrate.
- `height`: chiều cao video.
- `fps`: frame rate.
- `filesize`: dung lượng nếu có.
- `has_audio`: stream có âm thanh không.
- `has_video`: stream có hình ảnh không.

#### `MetadataResponse`

Thông tin chi tiết một video:

- metadata cơ bản: `id`, `url`, `title`, `thumbnail`, `duration`, `channel`.
- `audio_formats`: danh sách format audio.
- `video_formats`: danh sách format video.

#### `StreamPart`

Một phần stream cần tải:

- `kind`: `audio` hoặc `video`.
- `url`: direct stream URL.
- `ext`: đuôi file.
- `format_id`: mã format.

MP4 chất lượng cao có thể cần 2 `StreamPart`: một video-only và một audio-only.

#### `ExtractStreamResponse`

Response của `/api/extract-stream`:

- `title`: tiêu đề video.
- `requested_format`: format người dùng yêu cầu.
- `stream_url`: URL stream đầu tiên.
- `streams`: danh sách stream cần tải.

#### `DebugFormatItem` và `DebugFormatsResponse`

Dùng cho endpoint debug format. Nó giúp xem yt-dlp thực sự thấy những format nào, có URL hay không, protocol là gì.

### `backend/app/main.py`

Đây là entrypoint FastAPI.

#### `app = FastAPI(...)`

Tạo app backend với title, version, description.

#### `app.add_middleware(CORSMiddleware, ...)`

Cấu hình CORS để frontend gọi được backend.

#### `get_youtube_service(config)`

Dependency injection của FastAPI. Mỗi route cần `YoutubeService` thì gọi function này.

#### `api_error(code, message, hint)`

Tạo lỗi chuẩn dạng `ErrorDetail`.

#### `ytdlp_error_detail(exc)`

Xóa ANSI escape code trong lỗi yt-dlp để message sạch hơn.

#### `client_key(request)`

Lấy IP người gọi:

- Ưu tiên header `x-forwarded-for`.
- Nếu không có thì dùng `request.client.host`.
- Nếu không có nữa thì trả `"unknown"`.

#### `enforce_rate_limit(request, config)`

Giới hạn request theo IP. Function dùng `request_log`, mỗi IP có một queue thời gian request. Request cũ ngoài window bị loại bỏ. Nếu số request còn lại vượt giới hạn thì trả HTTP 429.

#### `validate_youtube_url(url)`

Chỉ cho URL `http` hoặc `https`, host thuộc:

- `youtube.com`
- `www.youtube.com`
- `m.youtube.com`
- `music.youtube.com`
- `youtu.be`

Nếu không hợp lệ, backend trả HTTP 400.

#### `handle_ytdlp_error(exc)`

Chuyển lỗi yt-dlp thành HTTP 502 có cấu trúc `{ code, message, hint }`.

#### `GET /health`

Endpoint kiểm tra backend còn sống. Trả:

```json
{"status": "ok"}
```

#### `GET /api/search`

Nhận:

- `q`: từ khóa hoặc URL.
- `limit`: số kết quả, mặc định 12, tối đa 60.

Route này rate limit request, validate URL nếu input là URL, rồi gọi `service.search()`.

#### `GET /api/metadata`

Nhận:

- `url`: URL YouTube.

Route này validate URL, rồi gọi `service.metadata()` để lấy danh sách format.

#### `GET /api/extract-stream`

Nhận:

- `url`: URL YouTube.
- `format`: format muốn tải, mặc định `auto_audio`.

Route này validate URL, gọi `service.extract_stream()`, rồi trả direct stream URL.

Nếu không tìm thấy format, route trả HTTP 404 với code `format_not_found`.

#### `GET /api/debug/formats`

Nhận:

- `url`: URL YouTube.

Route này trả danh sách format thô để debug lỗi `No downloadable formats found` hoặc `Requested format is not available`.

### `backend/app/youtube.py`

Đây là file quan trọng nhất của backend. Nó bọc logic yt-dlp vào class `YoutubeService`.

#### `YOUTUBE_WATCH_URL`

URL gốc dùng để tạo watch URL từ video id.

#### `class YoutubeService`

Class chuyên làm việc với YouTube qua yt-dlp.

#### `YoutubeService.__init__(settings)`

Nhận cấu hình `Settings` và lưu vào `self.settings`.

#### `YoutubeService._base_opts()`

Tạo options chuẩn cho yt-dlp:

- `ignoreconfig`: bỏ qua config yt-dlp cá nhân trên máy.
- `quiet`, `no_warnings`: giảm log.
- `skip_download`: không tải file thật về backend.
- `noplaylist`: không xử lý playlist đầy đủ.
- `ignore_no_formats_error`: không vỡ quá sớm khi format khó xử lý.
- `socket_timeout`, `retries`: timeout và retry.
- `extractor_args.youtube.player_client`: chọn player clients.

Nếu cấu hình dùng `bgutil`, function thêm config `youtubepot-bgutilhttp`.

#### `YoutubeService.search(query, limit)`

Nếu query là URL thì extract trực tiếp. Nếu query là từ khóa thì chuyển thành `ytsearch{limit}:query`.

Vì yt-dlp là tác vụ blocking, function dùng `asyncio.to_thread()` để chạy ở thread riêng, tránh block event loop FastAPI.

#### `YoutubeService.metadata(url)`

Gọi `_extract_info()` rồi chuyển dữ liệu thô thành `MetadataResponse`.

#### `YoutubeService.extract_stream(url, format_id)`

Gọi `_extract_info()`, sau đó `_select_streams()` để chọn stream phù hợp.

Trả về:

```text
(title, streams)
```

#### `YoutubeService.debug_formats(url)`

Lấy info và trả danh sách format rút gọn, phục vụ debug.

#### `YoutubeService._extract_info(url)`

Gọi trực tiếp:

```python
ydl.extract_info(url, download=False)
```

`download=False` nghĩa là chỉ lấy thông tin và direct URL, không tải file về server.

#### `YoutubeService._search_item(entry)`

Chuyển một entry thô của yt-dlp thành `SearchItem`.

Nó xử lý trường hợp entry chỉ có `id` hoặc URL tương đối.

#### `YoutubeService._metadata_response(info, url)`

Lọc danh sách format thành audio và video, sort theo chất lượng:

- Audio sort theo `abr` giảm dần.
- Video sort theo `height`, `vbr` giảm dần.

Sau đó trả tối đa 12 audio format và 20 video format.

#### `YoutubeService._select_streams(info, format_id)`

Đây là function chọn stream tải thật.

Các trường hợp:

- `auto_audio`, `mp3_128`, `mp3_320`, `mp3_256`, `mp3_64`: chọn audio candidate tốt nhất.
- `mp4_1080p`, `mp4_720p`, `mp4_480p`, `mp4_360p`: ưu tiên video-only + audio-only nếu có; nếu không có thì fallback sang progressive stream có cả audio và video.
- format id cụ thể, ví dụ `140`: tìm đúng format đó.

Nếu không tìm được, function raise `ValueError`; route sẽ đổi thành HTTP 404.

#### Helper functions trong `youtube.py`

- `_looks_like_url(value)`: kiểm tra chuỗi có bắt đầu bằng `http://` hoặc `https://`.
- `_optional_str(value)`: đổi value thành string nếu không phải `None`.
- `_best_thumbnail(info)`: lấy thumbnail tốt nhất.
- `_has_audio(fmt)`: format có audio codec không.
- `_has_video(fmt)`: format có video codec không.
- `_is_audio(fmt)`: chỉ audio, không video.
- `_is_video(fmt)`: có video và ext thuộc `mp4`, `webm`, `m4v`.
- `_is_progressive_video(fmt)`: có cả audio và video.
- `_is_media_file(fmt)`: ext thuộc nhóm media app hỗ trợ.
- `_format_item(fmt, item_type)`: đổi format thô thành `FormatItem`.
- `_stream_part(fmt, kind)`: đổi format thô thành `StreamPart`.

## 6. Frontend chi tiết

### `frontend/src/main.tsx`

File khởi động React.

Nó tìm element có id `root` trong `index.html`, rồi render component `App`.

### `frontend/src/types.ts`

File này định nghĩa type TypeScript tương ứng với schema backend.

Các type chính:

- `SearchItem`: một video trong kết quả tìm kiếm.
- `FormatItem`: một format audio/video.
- `Metadata`: metadata video.
- `StreamPart`: một stream cần tải.
- `ExtractStreamResponse`: response lấy stream.
- `DownloadChoice`: lựa chọn tải của người dùng.
- `DiagnosticStatus`: trạng thái diagnostics.
- `DiagnosticItem`: một dòng diagnostics.

Người mới nên sửa file này trước khi sửa dữ liệu API, vì nó giúp TypeScript bắt lỗi khi frontend/backend lệch nhau.

### `frontend/src/api.ts`

File này gom tất cả request từ frontend sang backend.

#### `API_BASE_URL`

Lấy từ biến môi trường `VITE_API_BASE_URL`. Nếu không có thì dùng local backend:

```text
http://127.0.0.1:8000
```

#### `getJson<T>(path)`

Wrapper fetch chung:

- Tạo `AbortController`.
- Timeout sau 30 giây.
- Gọi `${API_BASE_URL}${path}`.
- Nếu response lỗi thì đọc message bằng `readErrorMessage()`.
- Nếu OK thì parse JSON.

`<T>` là generic TypeScript, giúp function trả đúng kiểu dữ liệu mong muốn.

#### `readErrorMessage(response)`

Đọc lỗi từ backend:

- Nếu backend trả JSON có `detail` string thì dùng string đó.
- Nếu backend trả JSON có `detail.message` và `detail.hint` thì ghép lại.
- Nếu không parse được thì dùng text hoặc fallback `Request failed`.

#### `withDownloadHint(message)`

Thêm gợi ý nếu lỗi liên quan tới stream audio không tải được.

#### `searchVideos(query, limit)`

Gọi:

```text
GET /api/search?q=...&limit=...
```

Trả `SearchItem[]`.

#### `getMetadata(url)`

Gọi:

```text
GET /api/metadata?url=...
```

Trả `Metadata`.

#### `extractStream(url, formatId)`

Gọi:

```text
GET /api/extract-stream?url=...&format=...
```

Trả `ExtractStreamResponse`.

#### `checkBackendHealth()`

Gọi `/health`, phục vụ diagnostics.

### `frontend/src/download.ts`

File helper cho lựa chọn tải.

#### `toBackendFormatId(choice)`

Chuyển lựa chọn frontend thành format backend hiểu.

Ví dụ:

```text
{ mediaType: "audio", bitrate: "128k" } -> "mp3_128"
{ mediaType: "video", resolution: "720p" } -> "mp4_720p"
{ formatId: "140" } -> "140"
```

Nếu có `formatId` cụ thể, function ưu tiên dùng nó.

#### `formatBytes(value)`

Đổi byte thành chuỗi dễ đọc:

```text
1048576 -> "1.0 MB"
```

Nếu không biết dung lượng, trả `"Không rõ dung lượng"`.

#### `audioFormatChoice(format)`

Chuyển `FormatItem` audio từ backend thành `DownloadChoice`.

#### `videoFormatChoice(format)`

Chuyển `FormatItem` video từ backend thành `DownloadChoice`.

### `frontend/src/utils.ts`

#### `formatDuration(totalSeconds)`

Đổi giây thành định dạng thời gian:

```text
65 -> "1:05"
3665 -> "1:01:05"
```

#### `safeFilename(value, extension)`

Tạo tên file an toàn:

- Bỏ dấu tiếng Việt bằng normalize.
- Xóa ký tự Windows không cho dùng trong tên file: `\ / : * ? " < > |`.
- Gom khoảng trắng.
- Cắt tối đa 90 ký tự.
- Nếu rỗng thì dùng `pb-media`.

### `frontend/src/App.tsx`

Đây là component chính của app. Nó chứa state UI, logic search, modal chọn format, queue tải, diagnostics và render layout 3 cột.

#### Type nội bộ

- `ProgressPhase`: giai đoạn xử lý job, ví dụ `metadata`, `download`, `transcode`, `done`.
- `JobStatus`: trạng thái job, ví dụ `queued`, `processing`, `done`, `error`.
- `WarmStatus`: trạng thái preload FFmpeg.
- `CartJob`: dữ liệu một job trong hàng đợi.
- `WorkerMessage`: các message mà Web Worker gửi về main thread.

#### Constant chính

- `audioChoices`: preset MP3 320k, 256k, 128k, 64k.
- `videoChoices`: preset MP4 1080p, 720p, 480p, 360p.
- `CORS_PROXY_URL`: URL Cloudflare Worker proxy.
- `JOB_STORAGE_KEY`: key lưu queue trong `localStorage`.
- `INITIAL_SEARCH_LIMIT`, `SEARCH_LIMIT_STEP`, `MAX_SEARCH_LIMIT`: cấu hình phân trang search.
- `STREAM_TIMEOUT_MS`: timeout tải stream.

#### State chính trong `App`

- `query`: nội dung ô search.
- `results`: danh sách kết quả tìm kiếm.
- `jobs`: hàng đợi tải.
- `isAuto128k`: có tự chọn MP3 128kbps không.
- `useOriginalFile`: có tải file gốc không.
- `isSearching`, `isLoadingMore`: trạng thái loading.
- `searchLimit`, `lastSearchQuery`: quản lý load more.
- `activeVideo`: video đang mở modal chọn format.
- `metadata`: metadata của active video.
- `selectedChoice`: lựa chọn tải hiện tại.
- `activeTab`: tab audio/video trong modal.
- `concurrency`: số job chạy song song được đề xuất.
- `queueEnabled`: hàng đợi đang chạy hay tạm dừng.
- `warmStatus`, `warmDetail`: trạng thái FFmpeg preload.
- `diagnostics`, `isCheckingDiagnostics`: dữ liệu diagnostics.
- `error`: lỗi chung hiển thị trên UI.

#### Ref chính trong `App`

React state cập nhật bất đồng bộ, nên app dùng `useRef` cho dữ liệu cần đọc tức thời trong queue:

- `jobsRef`: bản mới nhất của jobs.
- `runningRef`: set job đang chạy.
- `queueEnabledRef`: queue đang bật hay không.
- `preloadWorkerRef`: worker preload FFmpeg.
- `activeWorkersRef`: worker đang chạy theo job id.
- `activeAbortRef`: abort controller cho tải file gốc.
- `cancelResolversRef`: resolve promise khi cancel worker.
- `cancelledJobsRef`: set job đã bị hủy.

#### `useEffect` đồng bộ jobs

Khi `jobs` đổi:

- Cập nhật `jobsRef.current`.
- Gọi `saveJobs(jobs)` để lưu queue vào localStorage.

#### `useEffect` chạy queue

Khi `queueEnabled`, `concurrency` hoặc số lượng jobs đổi:

- Cập nhật `queueEnabledRef`.
- Nếu queue đang bật thì gọi `pumpQueue()`.

#### `useEffect` khởi động FFmpeg

Khi app mount:

- Gọi `warmUpFFmpeg()` để preload FFmpeg.
- Khi unmount, revoke Blob URL, terminate worker, abort request.

#### `queueStats`

`useMemo` tính số job queued/running/done.

#### `availableChoices`

Nếu đã có metadata, lấy format thật từ backend. Nếu chưa có metadata, dùng preset mặc định.

#### `handleSearch(event)`

Xử lý submit search form:

- Chặn reload trang bằng `event.preventDefault()`.
- Bỏ qua nếu query rỗng.
- Reset error/loading.
- Gọi `searchVideos()`.
- Lưu kết quả vào `results`.

#### `handleLoadMore()`

Tăng `searchLimit`, gọi lại search với limit lớn hơn, rồi render thêm kết quả.

#### `openVideo(video)`

Mở modal chọn định dạng:

- Set `activeVideo`.
- Reset metadata.
- Mặc định chọn MP3 128k.
- Gọi `getMetadata(video.url)`.
- Nếu có audio format tốt nhất thì chọn format đó.

#### `addJob(video, choice, useOriginal)`

Tạo `CartJob` mới:

- `id`: ghép video id, timestamp và random string.
- `status`: `queued`.
- `phase`: `metadata`.
- `progress`: `0`.

Sau đó thêm vào cuối `jobs`.

#### `startQueue()`

Bật queue và gọi `pumpQueue()`.

#### `pauseQueue()`

Tắt queue. Các job đang chạy không tự dừng; function này chủ yếu ngăn job mới bắt đầu.

#### `retryJob(id)`

Đưa job lỗi hoặc đã hủy về `queued`:

- Xóa cờ cancel.
- Revoke URL cũ nếu có.
- Reset progress, stage, filename, error.
- Nếu queue đang bật thì pump lại.

#### `cancelJob(id)`

Hủy job:

- Đánh dấu id trong `cancelledJobsRef`.
- Abort request nếu là tải file gốc.
- Terminate worker nếu đang transcode.
- Xóa khỏi running set.
- Update trạng thái thành `cancelled`.

#### `pumpQueue()`

Máy bơm hàng đợi:

- Nếu queue đang tắt thì dừng.
- Tính số slot trống bằng `concurrency - runningRef.size`.
- Lấy các job `queued` chưa chạy.
- Gọi `runJob(job)` cho từng slot.
- Khi job xong thì xóa khỏi running và pump tiếp.

#### `runJob(job)`

Luồng chính của một job:

1. Update trạng thái `preparing`.
2. Gọi backend `extractStream()`.
3. Nếu `useOriginal` thì gọi `downloadOriginalJob()`.
4. Nếu không thì gọi `transcodeJob()`.
5. Nếu lỗi thì update status `error`.
6. Cuối cùng dọn worker, abort controller, resolver.

#### `transcodeJob(job, stream)`

Tạo Web Worker để chuyển mã:

- Worker gửi `PROGRESS`: update progress.
- Worker gửi `ERROR`: fallback sang tải file gốc.
- Worker gửi `DONE`: tạo Blob, tạo filename, trigger browser download, lưu downloadUrl.

#### `downloadOriginalJob(job, stream)`

Tải stream đầu tiên không qua FFmpeg:

- Tạo `AbortController`.
- Gọi `fetchStreamBlob()`.
- Tạo file extension từ stream.
- Tạo Blob URL.
- Tự kích hoạt download.
- Update job `done`.

#### `fallbackOriginal(job, stream, reason)`

Khi FFmpeg lỗi, đổi job sang trạng thái fallback rồi gọi `downloadOriginalJob()`.

#### `warmUpFFmpeg()`

Preload FFmpeg bằng worker riêng:

- Gửi message `PRELOAD`.
- Nếu worker báo `READY`, set `warmStatus = ready`.
- Nếu worker báo `ERROR`, hiển thị lỗi.

#### `updateJob(id, patch)`

Update một job theo id. Nếu thay `downloadUrl`, function revoke URL cũ để tránh rò bộ nhớ.

#### `removeJob(id)`

Xóa job khỏi queue. Nếu job có Blob URL thì revoke trước.

#### `clearFinishedJobs()`

Xóa các job đã `done`, `error`, `cancelled`. Blob URL cũng được revoke.

#### `runDiagnostics()`

Chạy toàn bộ kiểm tra runtime:

- API URL.
- Worker URL.
- Cross-origin isolation.
- Backend health.
- FFmpeg wasm asset.
- Worker CORS.

#### Component `ToggleCard`

Card có checkbox dạng toggle. Dùng cho tùy chọn bật/tắt.

#### Component `MiniStat`

Hiển thị một thống kê nhỏ có icon, label, value.

#### Component `StatusCard`

Hiển thị trạng thái như FFmpeg, queue, runtime.

#### Component `DiagnosticsPanel`

Hiển thị danh sách diagnostics và nút refresh.

#### Component `JobRow`

Render một job trong queue:

- Badge trạng thái.
- Tên video.
- Stage/detail.
- Progress bar.
- Thời gian đã chạy và ETA.
- Nút tải file, thử lại, hủy, xóa.

#### `fetchStreamBlob(streamUrl, onProgress, signal)`

Tải stream qua CORS proxy và trả về `Blob`.

Nó ghép URL:

```text
{CORS_PROXY_URL}/?url={encoded direct stream URL}
```

#### `readResponseBlobWithProgress(response, onProgress, signal)`

Đọc response body theo từng chunk để tính progress tải.

#### `getProgressTiming(job)`

Tính elapsed và ETA dựa trên `startedAt` và `progress`.

#### `getQueueStats(jobs)`

Đếm job đang chờ, đang chạy, đã xong.

#### `phaseLabel(phase)` và `phaseWaitHint(phase)`

Map phase kỹ thuật thành text hiển thị cho người dùng.

#### `statusLabel(status)` và `statusClass(status)`

Map status kỹ thuật thành nhãn và CSS class.

#### `warmLabel(status)`

Map trạng thái FFmpeg preload thành text.

#### `diagnosticLabel(status)` và `diagnosticClass(status)`

Map trạng thái diagnostics thành nhãn và CSS class.

#### `initialDiagnostics()`

Tạo danh sách diagnostics mặc định trước khi kiểm tra thật.

#### `checkHealthDiagnostic()`

Gọi backend `/health`.

#### `checkAssetDiagnostic(path, label)`

Kiểm tra asset FFmpeg wasm có tồn tại và content type có đúng `application/wasm` không.

#### `checkWorkerDiagnostic()`

Gọi Worker bằng một URL test để xem proxy có trả response không.

#### `choiceLabel(choice)` và `jobChoiceLabel(job)`

Tạo nhãn cho lựa chọn tải.

#### `formatSeconds(totalSeconds)`

Đổi giây thành text ngắn như `15s`, `2m 10s`.

#### `clampProgress(progress)`

Ép progress nằm trong khoảng 0 đến 100.

#### `detectRecommendedWorkers()`

Dựa vào `navigator.hardwareConcurrency` và `navigator.deviceMemory` để đề xuất số job chạy song song:

- Máy mạnh: 2-3 worker.
- Máy thường/yếu: 1 worker.

#### `looksLikeUrl(value)`

Kiểm tra input có giống URL không.

#### `triggerBrowserDownload(url, filename)`

Tạo thẻ `<a>`, click tự động để browser tải file.

#### `loadSavedJobs()`

Đọc queue từ localStorage.

Nếu trước đó job đang chạy mà người dùng reload trang, function đưa job về `queued` để chạy lại từ đầu.

#### `saveJobs(jobs)`

Lưu queue vào localStorage. Không lưu `downloadUrl` vì Blob URL chỉ có nghĩa trong phiên browser hiện tại.

### `frontend/src/workers/transcode.worker.ts`

File này chạy trong Web Worker, tách khỏi UI thread.

#### `ProgressStage`

Các phase worker gửi về UI:

- `init`
- `download`
- `write`
- `transcode`
- `package`

#### `WorkerRequest`

Message worker nhận:

- `PRELOAD`: chỉ khởi tạo FFmpeg.
- `TRANSCODE`: tải stream và chuyển mã.

#### `ffmpeg` và `loaded`

- `ffmpeg`: instance FFmpeg.wasm.
- `loaded`: cờ tránh load FFmpeg nhiều lần trong cùng worker.

#### `self.onmessage`

Entry chính của worker.

Nếu message là `PRELOAD`:

- Gọi `ensureLoaded()`.
- Gửi `READY`.

Nếu message là `TRANSCODE`:

1. Gọi `ensureLoaded()`.
2. Fetch từng stream qua CORS proxy.
3. Ghi stream vào filesystem ảo của FFmpeg.
4. Nếu audio: chạy FFmpeg tạo `output.mp3`.
5. Nếu video: ghép video/audio hoặc copy stream tạo `output.mp4`.
6. Đọc output.
7. Gửi `DONE` về main thread.

Nếu lỗi, gửi `ERROR`.

#### `ensureLoaded()`

Load `ffmpeg-core.js` và `ffmpeg-core.wasm` từ `/ffmpeg`.

Function dùng `toBlobURL()` để chuyển asset thành Blob URL phù hợp cho FFmpeg.wasm.

#### `withTimeout(promise, timeoutMs, message)`

Bọc một promise với timeout. Nếu quá thời gian, reject bằng message rõ ràng.

#### `fetchStream(corsProxyUrl, streamUrl, onProgress)`

Fetch media qua Cloudflare Worker proxy, đọc từng chunk và trả `ArrayBuffer`.

#### `postProgress(stage, progress, phase, detail)`

Gửi progress về UI.

#### `postDone(data, mimeType, extension)`

Gửi kết quả binary về UI bằng transferable object để tránh copy bộ nhớ không cần thiết.

## 7. Cloudflare Worker chi tiết

### `cloudflare-worker/worker.js`

#### `ALLOWED_HOSTS`

Danh sách host được proxy:

- `googlevideo.com`
- `youtube.com`
- `ytimg.com`

#### `fetch(request, env)`

Entry của Worker.

Luồng xử lý:

1. Đọc `Origin`.
2. Đọc env `ALLOWED_ORIGINS`.
3. Nếu request là `OPTIONS`, trả CORS preflight.
4. Chỉ cho `GET` và `HEAD`.
5. Đọc query `?url=`.
6. Parse URL target.
7. Kiểm tra target bằng `isAllowedTarget()`.
8. Copy một số header cần thiết như `User-Agent`, `Accept`, `Range`.
9. Fetch upstream.
10. Gắn CORS headers vào response.
11. Trả body upstream về browser.

#### `isAllowedTarget(url)`

Chỉ cho URL:

- Protocol là `https:`.
- Host bằng hoặc là subdomain của các host trong `ALLOWED_HOSTS`.

Function này ngăn Worker bị dùng làm proxy mở cho website bất kỳ.

#### `corsHeaders(origin)`

Tạo CORS headers:

- Cho phép `GET, HEAD, OPTIONS`.
- Cho phép header `Range`.
- Expose `Content-Length`, `Content-Range`, `Accept-Ranges`, `Content-Type`.

Các header range rất quan trọng với media stream.

#### `json(payload, status, origin)`

Helper trả JSON lỗi hoặc response nhỏ có CORS.

## 8. Config và biến môi trường

### Frontend

Các biến quan trọng:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_CORS_PROXY_URL=http://127.0.0.1:8787
```

Nếu deploy:

```env
VITE_API_BASE_URL=https://your-backend-domain
VITE_CORS_PROXY_URL=https://your-worker-domain.workers.dev
```

### Backend

Các biến quan trọng:

```env
FRONTEND_ORIGINS=https://your-frontend-domain
YTDLP_PLAYER_CLIENTS=web,mweb,ios,android
YTDLP_POT_PROVIDER=bgutil
YTDLP_BGUTIL_BASE_URL=http://127.0.0.1:4416
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_REQUESTS=30
```

### Cloudflare Worker

```env
ALLOWED_ORIGINS=https://your-frontend-domain
```

## 9. Vì sao cần COOP/COEP?

FFmpeg.wasm cần môi trường browser đủ cô lập để dùng một số tính năng WebAssembly hiệu năng cao.

Dự án cấu hình trong `frontend/vite.config.ts`:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

Nếu thiếu các header này, `window.crossOriginIsolated` có thể là `false`, và FFmpeg.wasm có thể lỗi runtime.

## 10. Test hiện có

### Backend test

File: `backend/tests/test_youtube_service.py`

Kiểm tra:

- URL YouTube hợp lệ được chấp nhận.
- URL ngoài YouTube bị reject.
- `_select_streams()` chọn audio-only cho MP3.
- `_select_streams()` chọn video-only + audio-only cho MP4.
- Fallback sang progressive video.
- Raise lỗi nếu không có format.

### Frontend test

File: `frontend/tests/download.test.mjs`

Kiểm tra:

- `toBackendFormatId()` ưu tiên format id thật.
- `toBackendFormatId()` tạo preset legacy.
- `formatBytes()` format dung lượng.

### Worker test

File: `cloudflare-worker/tests/worker.test.mjs`

Kiểm tra:

- Worker cho phép YouTube media hosts qua HTTPS.
- Worker reject HTTP và host lạ.
- CORS headers expose range metadata.

## 11. Cách chạy dự án local

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Kiểm tra:

```powershell
Invoke-WebRequest "http://127.0.0.1:8000/health" -UseBasicParsing
```

### Cloudflare Worker local

```powershell
cd cloudflare-worker
npm install
npm run dev
```

Mặc định Worker chạy ở:

```text
http://127.0.0.1:8787
```

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

Mặc định frontend chạy ở:

```text
http://127.0.0.1:5173
```

## 12. Cách làm lại dự án từ đầu

Nếu muốn tự làm lại để học, làm theo các chặng sau.

### Chặng 1: Làm backend đơn giản

1. Tạo FastAPI app.
2. Tạo `/health`.
3. Tạo schema `SearchItem`, `MetadataResponse`, `ExtractStreamResponse`.
4. Viết `validate_youtube_url()`.
5. Viết `YoutubeService._base_opts()`.
6. Viết `/api/search`.
7. Viết `/api/metadata`.
8. Viết `/api/extract-stream`.

Mục tiêu của chặng này: Postman hoặc browser gọi API và thấy JSON trả về.

### Chặng 2: Làm frontend search

1. Tạo React app bằng Vite.
2. Tạo `types.ts`.
3. Tạo `api.ts`.
4. Tạo form search.
5. Render danh sách video.
6. Click video để gọi metadata.

Mục tiêu của chặng này: search được video và xem format.

### Chặng 3: Làm queue tải

1. Tạo type `CartJob`.
2. Viết `addJob()`.
3. Viết `startQueue()`, `pauseQueue()`, `pumpQueue()`.
4. Viết `runJob()`.
5. Gọi `/api/extract-stream`.

Mục tiêu của chặng này: job chạy qua các trạng thái rõ ràng.

### Chặng 4: Làm Worker proxy

1. Tạo Cloudflare Worker.
2. Nhận `?url=`.
3. Validate target host.
4. Forward `Range`.
5. Trả CORS headers.

Mục tiêu của chặng này: browser fetch được stream qua proxy.

### Chặng 5: Làm tải file gốc

1. Viết `fetchStreamBlob()`.
2. Đọc stream theo chunk.
3. Tính progress.
4. Tạo Blob URL.
5. Trigger browser download.

Mục tiêu của chặng này: tải được file gốc về máy.

### Chặng 6: Thêm FFmpeg.wasm

1. Cài `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core`.
2. Copy ffmpeg core vào `public/ffmpeg`.
3. Tạo Web Worker.
4. Load FFmpeg bằng `ensureLoaded()`.
5. Ghi input file bằng `ffmpeg.writeFile()`.
6. Chạy `ffmpeg.exec()`.
7. Đọc output bằng `ffmpeg.readFile()`.
8. Gửi binary về main thread.

Mục tiêu của chặng này: tạo được MP3 hoặc MP4 từ stream.

### Chặng 7: Thêm diagnostics và test

1. Kiểm tra backend health.
2. Kiểm tra Worker URL.
3. Kiểm tra FFmpeg wasm asset.
4. Kiểm tra `window.crossOriginIsolated`.
5. Viết unit test cho stream selection.
6. Viết unit test cho Worker host validation.

Mục tiêu của chặng này: biết lỗi nằm ở frontend, backend, Worker, CORS hay FFmpeg.

## 13. Những lỗi dễ gặp

### `No downloadable formats found`

Không nên vội kết luận frontend lỗi. Cần kiểm tra yt-dlp, player client, PO token, hoặc dùng endpoint debug format để xem backend thấy gì.

### `Requested format is not available`

Có thể video không có audio-only/video-only như kỳ vọng. Cần xem raw formats. Một số video chỉ có progressive format như `18`.

### Direct URL hết hạn

Direct URL của YouTube thường hết hạn nhanh. Khi retry job, app phải gọi lại `/api/extract-stream`, không dùng URL cũ.

### FFmpeg.wasm không chạy

Kiểm tra:

- `/ffmpeg/ffmpeg-core.wasm` có tải được không.
- Content type có phải `application/wasm` không.
- `window.crossOriginIsolated` có `true` không.
- Browser có đủ RAM/CPU không.

### CORS lỗi khi fetch stream

Kiểm tra:

- `VITE_CORS_PROXY_URL`.
- Worker có deploy không.
- `ALLOWED_ORIGINS`.
- Worker có expose header range không.

## 14. Nguyên tắc khi sửa dự án

1. Sửa schema trước nếu thay đổi dữ liệu API.
2. Không lưu direct stream URL lâu dài.
3. Không để backend tải file media nặng nếu mục tiêu là chi phí thấp.
4. Khi thêm feature tải mới, kiểm tra cả 3 nơi: backend chọn stream, frontend tạo choice, worker xử lý file.
5. Khi sửa text tiếng Việt, kiểm tra toàn bộ JSX, worker message, API message và test output.
6. Khi sửa queue, chú ý cleanup: `URL.revokeObjectURL()`, `worker.terminate()`, `AbortController.abort()`.
7. Khi debug yt-dlp, phân biệt đường debug raw formats và đường extract stream bình thường.

## 15. Bản đồ nhanh file nào sửa khi thêm feature

### Thêm loại format mới

Sửa:

- `backend/app/youtube.py`: `_select_streams()`.
- `frontend/src/types.ts`: nếu cần type mới.
- `frontend/src/download.ts`: map choice sang backend format id.
- `frontend/src/App.tsx`: UI chọn format.
- `frontend/src/workers/transcode.worker.ts`: lệnh FFmpeg nếu output mới.
- Tests tương ứng.

### Thêm endpoint backend mới

Sửa:

- `backend/app/schemas.py`: schema response.
- `backend/app/main.py`: route.
- `backend/app/youtube.py`: service nếu cần yt-dlp.
- `frontend/src/api.ts`: function gọi API.
- `frontend/src/types.ts`: type response.

### Thêm kiểm tra diagnostics mới

Sửa:

- `frontend/src/types.ts`: nếu thêm status hoặc field mới.
- `frontend/src/App.tsx`: `initialDiagnostics()`, `runDiagnostics()`, component hiển thị nếu cần.

### Thêm host proxy mới

Sửa:

- `cloudflare-worker/worker.js`: `ALLOWED_HOSTS`.
- `cloudflare-worker/tests/worker.test.mjs`: test allow/reject host.

## 16. Tóm tắt tư duy kiến trúc

Dự án tách trách nhiệm khá rõ:

- Backend hiểu YouTube và yt-dlp.
- Worker hiểu CORS proxy và stream.
- Frontend hiểu UI, queue và trải nghiệm người dùng.
- Web Worker hiểu FFmpeg và xử lý file nặng.

Khi có lỗi, hãy hỏi: lỗi đang nằm ở bước nào trong chuỗi này?

```text
Search -> Metadata -> Extract stream -> Proxy fetch -> FFmpeg -> Browser download
```

Trả lời được câu hỏi đó thì việc debug sẽ dễ hơn nhiều.
