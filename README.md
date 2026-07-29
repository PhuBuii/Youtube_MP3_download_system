# PB Media Fetch MP3/MP4 Downloader

PB Media Fetch là web app tải và chuyển mã media theo hướng chi phí thấp:

- Frontend: React + Vite + TypeScript + Tailwind CSS.
- Client transcoder: Web Worker + FFmpeg.wasm.
- Backend: FastAPI + yt-dlp, chỉ trả metadata và direct stream URL.
- CORS proxy: Cloudflare Worker để browser fetch stream từ các host YouTube/Googlevideo.

> Chỉ dùng với nội dung bạn sở hữu quyền tải xuống hoặc được phép sử dụng. YouTube và nhà xuất bản có thể áp dụng điều khoản hoặc giới hạn kỹ thuật riêng.

## Cấu trúc

```text
frontend/             React UI + FFmpeg.wasm worker
backend/              FastAPI API metadata/direct stream
cloudflare-worker/    Worker CORS/range proxy
```

## Chạy local

### 1. Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Kiểm tra:

```powershell
Invoke-WebRequest "http://127.0.0.1:8000/health" -UseBasicParsing
```

### 2. Cloudflare Worker local

```powershell
cd cloudflare-worker
npm install
npm run dev
```

Worker local mặc định chạy ở `http://127.0.0.1:8787`.

### 3. Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

Frontend mặc định gọi:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_CORS_PROXY_URL=http://127.0.0.1:8787
```

Vite dev/preview, Vercel và Netlify đều cần các header dưới đây để FFmpeg.wasm chạy ổn định:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

## Deploy 0 USD/tháng

1. Deploy Cloudflare Worker trước.
   - Root: `cloudflare-worker`
   - Command: `npm install && npm run deploy`
   - Set secret/env: `ALLOWED_ORIGINS=https://your-frontend-domain`

2. Deploy backend trên Render.
   - Root: `backend`
   - Dockerfile: `backend/Dockerfile`
   - Health check path: `/health`
   - Env:

```env
FRONTEND_ORIGINS=https://your-frontend-domain
YTDLP_PLAYER_CLIENTS=web,mweb,ios,android
YTDLP_POT_PROVIDER=bgutil
YTDLP_BGUTIL_BASE_URL=http://127.0.0.1:4416
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_REQUESTS=30
```

3. Deploy frontend trên Vercel hoặc Netlify.
   - Root: `frontend`
   - Build command: `npm run build`
   - Output: `dist`
   - Env:

```env
VITE_API_BASE_URL=https://your-backend-domain
VITE_CORS_PROXY_URL=https://your-worker-domain.workers.dev
```

4. Sau khi frontend có domain cuối, cập nhật lại:
   - Backend `FRONTEND_ORIGINS`
   - Worker `ALLOWED_ORIGINS`

## Diagnostics và smoke tests

Trong UI, bấm nút refresh ở khối `Diagnostics` để kiểm tra:

- API base URL.
- CORS Worker URL.
- `window.crossOriginIsolated`.
- Backend `/health`.
- `/ffmpeg/ffmpeg-core.wasm` và content type `application/wasm`.
- Worker CORS proxy.

Lệnh kiểm tra source:

```powershell
npm --prefix frontend run build
npm --prefix frontend test
npm --prefix cloudflare-worker test
backend\.venv\Scripts\python.exe -m unittest discover -s backend\tests
backend\.venv\Scripts\python.exe -m compileall backend\app
```

Runtime smoke test thủ công:

1. Mở frontend local hoặc production.
2. Chạy Diagnostics và xác nhận các mục quan trọng là `OK`.
3. Dán một URL YouTube hợp lệ.
4. Thử auto MP3 128kbps.
5. Tắt auto, mở modal chọn chất lượng, xác nhận danh sách format thật hiển thị bitrate/resolution/dung lượng.
6. Thêm job, bấm bắt đầu, thử tạm dừng queue, hủy job, thử lại job lỗi/hủy.
7. Tải file gốc và một job chuyển mã MP3 để xác nhận Worker + FFmpeg.

## Ghi chú vận hành

- Backend chặn URL ngoài YouTube và áp rate limit nhẹ theo IP để giảm lạm dụng.
- API lỗi trả dạng có cấu trúc `{ code, message, hint }`; frontend hiển thị `message + hint`.
- Direct URL của YouTube thường hết hạn nhanh; job retry sẽ gọi lại `/api/extract-stream` để lấy URL mới.
- FFmpeg.wasm chạy trong browser nên file dài có thể tốn RAM/CPU của người dùng.
- Backend không stream file về server, không tải hoặc nén file.
- Lỗi Chrome DevTools `Unchecked runtime.lastError: Could not establish connection...` thường đến từ extension trình duyệt, không phải app.
