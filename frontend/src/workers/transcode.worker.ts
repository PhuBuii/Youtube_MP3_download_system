import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

import type { DownloadChoice, StreamPart } from "../types";

type ProgressStage = "init" | "download" | "write" | "transcode" | "package";

type WorkerRequest =
  | { type: "PRELOAD" }
  | {
      type: "TRANSCODE";
      streams: StreamPart[];
      choice: DownloadChoice;
      corsProxyUrl: string;
    };

const ffmpeg = new FFmpeg();
let loaded = false;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === "PRELOAD") {
      await ensureLoaded();
      self.postMessage({ type: "READY" });
      return;
    }

    if (event.data.type !== "TRANSCODE") return;

    await ensureLoaded();
    const { streams, choice, corsProxyUrl } = event.data;

    postProgress("Đang tải stream", 6, "download", "Đang tải dữ liệu media từ Google video server qua CORS proxy.");
    const files = await Promise.all(
      streams.map(async (stream, index) => {
        const extension = stream.ext || (stream.kind === "video" ? "mp4" : "m4a");
        const name = `${stream.kind}-${index}.${extension}`;
        const buffer = await fetchStream(corsProxyUrl, stream.url, (progress) => {
          postProgress(
            "Đang tải stream",
            Math.min(48, 8 + progress * 0.4),
            "download",
            `Đã tải ${Math.round(progress)}% stream ${stream.kind}.`,
          );
        });
        postProgress("Đang ghi file vào FFmpeg", 49, "write", "Đang đưa dữ liệu vào bộ nhớ ảo của FFmpeg.wasm.");
        await ffmpeg.writeFile(name, new Uint8Array(buffer));
        return { ...stream, name };
      }),
    );

    postProgress(
      "Đang chuyển mã",
      50,
      "transcode",
      "FFmpeg đang xử lý trong trình duyệt. Tốc độ phụ thuộc CPU, RAM và độ dài media.",
    );
    ffmpeg.on("progress", ({ progress }) => {
      postProgress(
        "Đang chuyển mã",
        Math.min(98, 50 + progress * 48),
        "transcode",
        `FFmpeg đã xử lý ${Math.round(progress * 100)}% tác vụ chuyển mã.`,
      );
    });

    if (choice.mediaType === "audio") {
      const input = files.find((file) => file.kind === "audio")?.name ?? files[0].name;
      await ffmpeg.exec(["-i", input, "-vn", "-b:a", choice.bitrate ?? "128k", "output.mp3"]);
      postProgress("Đang đóng gói file", 99, "package", "Đang đọc file MP3 từ FFmpeg để trình duyệt tải xuống.");
      const data = await ffmpeg.readFile("output.mp3");
      postDone(data, "audio/mpeg", "mp3");
      return;
    }

    const video = files.find((file) => file.kind === "video")?.name ?? files[0].name;
    const audio = files.find((file) => file.kind === "audio")?.name;
    const args = audio
      ? ["-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "output.mp4"]
      : ["-i", video, "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "output.mp4"];
    await ffmpeg.exec(args);
    postProgress("Đang đóng gói file", 99, "package", "Đang đọc file MP4 từ FFmpeg để trình duyệt tải xuống.");
    const data = await ffmpeg.readFile("output.mp4");
    postDone(data, "video/mp4", "mp4");
  } catch (error) {
    self.postMessage({ type: "ERROR", error: error instanceof Error ? error.message : "Worker xử lý thất bại." });
  }
};

async function ensureLoaded() {
  if (loaded) return;

  postProgress("Đang khởi tạo FFmpeg", 1, "init", "Lần đầu có thể mất 20-180 giây vì browser phải tải và compile FFmpeg.wasm.");
  const baseUrl = `${self.location.origin}/ffmpeg`;
  await withTimeout(
    ffmpeg.load({
      coreURL: await toBlobURL(`${baseUrl}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, "application/wasm"),
    }),
    180000,
    "Không khởi tạo được FFmpeg trong 180 giây. Hãy kiểm tra /ffmpeg/ffmpeg-core.wasm trong Network tab.",
  );
  loaded = true;
  postProgress("FFmpeg đã sẵn sàng", 5, "init", "Đã khởi tạo xong bộ chuyển mã trong browser.");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchStream(corsProxyUrl: string, streamUrl: string, onProgress: (progress: number) => void): Promise<ArrayBuffer> {
  const proxied = `${corsProxyUrl.replace(/\/$/, "")}/?url=${encodeURIComponent(streamUrl)}`;
  const response = await fetch(proxied);
  if (!response.ok || !response.body) {
    throw new Error(`Không tải được stream: ${response.status}`);
  }

  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) onProgress((received / total) * 100);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(100);
  return merged.buffer;
}

function postProgress(stage: string, progress: number, phase: ProgressStage, detail: string) {
  self.postMessage({ type: "PROGRESS", stage, progress: Math.round(progress), phase, detail });
}

function postDone(data: Uint8Array | string, mimeType: string, extension: string) {
  if (typeof data === "string") {
    throw new Error("FFmpeg trả về dữ liệu dạng text thay vì binary.");
  }
  self.postMessage({ type: "DONE", buffer: data.buffer, mimeType, extension }, [data.buffer]);
}
