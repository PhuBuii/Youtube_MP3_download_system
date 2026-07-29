import type { ExtractStreamResponse, Metadata, SearchItem } from "./types";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

const API_TIMEOUT_MS = 30000;

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("API phản hồi quá lâu. Hãy kiểm tra backend hoặc thử lại.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback =
    `Request failed: ${response.status} ${response.statusText}`.trim();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => null)) as
      | {
          detail?:
            | string
            | {
                code?: string;
                message?: string;
                hint?: string | null;
              };
        }
      | null;
    if (typeof body?.detail === "string" && body.detail.trim()) {
      return withDownloadHint(body.detail.trim());
    }
    if (
      body?.detail &&
      typeof body.detail === "object" &&
      typeof body.detail.message === "string"
    ) {
      const hint = body.detail.hint ? ` ${body.detail.hint}` : "";
      return withDownloadHint(`${body.detail.message}${hint}`.trim());
    }
  }

  const text = await response.text().catch(() => "");
  return withDownloadHint(text.trim() || fallback);
}

function withDownloadHint(message: string): string {
  if (/no downloadable audio stream|không tìm thấy stream âm thanh/i.test(message)) {
    return `${message} Hãy thử video khác hoặc tắt chế độ tự động MP3 128kbps để xem các định dạng khả dụng.`;
  }
  return message;
}

export async function searchVideos(
  query: string,
  limit = 12,
): Promise<SearchItem[]> {
  const data = await getJson<{ results: SearchItem[] }>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return data.results;
}

export function getMetadata(url: string): Promise<Metadata> {
  return getJson<Metadata>(`/api/metadata?url=${encodeURIComponent(url)}`);
}

export function extractStream(
  url: string,
  formatId: string,
): Promise<ExtractStreamResponse> {
  return getJson<ExtractStreamResponse>(
    `/api/extract-stream?url=${encodeURIComponent(url)}&format=${encodeURIComponent(formatId)}`,
  );
}

export function checkBackendHealth(): Promise<{ status: string }> {
  return getJson<{ status: string }>("/health");
}
