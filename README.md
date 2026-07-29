# SonicFetch MP3/MP4 Downloader

Web app tải và chuyển mã media phía client để giữ chi phí hạ tầng ở mức 0 USD/tháng:

- Frontend: React + Vite + TypeScript + Tailwind CSS.
- Client transcoder: Web Worker + FFmpeg.wasm.
- Backend: FastAPI + yt-dlp chỉ trả metadata và direct stream URL, không tải hoặc nén file.
- CORS proxy: Cloudflare Worker để frontend fetch stream từ `googlevideo.com`.

> Chỉ dùng với nội dung bạn sở hữu quyền tải xuống hoặc được phép sử dụng. YouTube/nhà xuất bản có thể áp dụng điều khoản và giới hạn kỹ thuật riêng.

## Cấu trúc

```text
frontend/             React UI + FFmpeg.wasm worker
backend/              FastAPI API proxy metadata/stream
cloudflare-worker/    Worker CORS proxy
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
Invoke-WebRequest "http://127.0.0.1:8000/health"
```

Debug formats của một video khi `/api/extract-stream` trả lỗi:

```powershell
Invoke-WebRequest "http://127.0.0.1:8000/api/debug/formats?url=https://www.youtube.com/watch?v=VIDEO_ID" -UseBasicParsing
```

### 2. Frontend

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

Mặc định frontend gọi backend tại `http://127.0.0.1:8000` và dùng CORS proxy URL trong `.env`.

### 3. Cloudflare Worker

```powershell
cd cloudflare-worker
npm install -g wrangler
wrangler deploy
```

Sau khi deploy, copy Worker URL vào `frontend/.env`:

```env
VITE_CORS_PROXY_URL=https://your-worker.your-subdomain.workers.dev
```

## Deploy 0 USD/tháng

- Frontend: Vercel hoặc Netlify free tier.
- Backend: Render free web service dùng `backend/Dockerfile`.
- CORS proxy: Cloudflare Worker free tier.

## Biến môi trường chính

Backend:

```env
FRONTEND_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
YTDLP_PLAYER_CLIENTS=web,mweb,ios,android
YTDLP_POT_PROVIDER=bgutil
YTDLP_BGUTIL_BASE_URL=http://127.0.0.1:4416
```

Frontend:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_CORS_PROXY_URL=http://127.0.0.1:8787
```

## Ghi chú vận hành

- FFmpeg.wasm chạy trong trình duyệt nên file dài có thể tốn RAM/CPU của người dùng.
- FFmpeg core được self-host tại `frontend/public/ffmpeg/`, frontend không tải core từ CDN lúc runtime.
- Backend không stream file về server, chỉ bóc metadata và direct URL.
- Direct URL của YouTube thường hết hạn nhanh; luôn gọi `/api/extract-stream` ngay trước khi tải.
- Workflow nên đi theo mô hình Y2Mate-like: paste/search URL, lấy metadata/formats, chọn format hoặc dùng auto 128kbps, rồi tải/chuyển mã ở client.
- Lỗi `Unchecked runtime.lastError: Could not establish connection...` trong Chrome DevTools thường đến từ extension trình duyệt, không phải app. Khi debug FFmpeg, ưu tiên xem Network tab cho `/ffmpeg/ffmpeg-core.js` và `/ffmpeg/ffmpeg-core.wasm`.
