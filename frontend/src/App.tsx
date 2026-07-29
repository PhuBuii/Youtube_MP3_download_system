import {
  Activity,
  CheckCircle2,
  Clock3,
  Cpu,
  FileDown,
  Loader2,
  Music2,
  Pause,
  Play,
  PlusCircle,
  Search,
  ShoppingCart,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { extractStream, getMetadata, searchVideos } from "./api";
import type {
  DownloadChoice,
  ExtractStreamResponse,
  Metadata,
  SearchItem,
} from "./types";
import { formatDuration, safeFilename } from "./utils";

type ProgressPhase =
  | "metadata"
  | "init"
  | "download"
  | "write"
  | "transcode"
  | "package"
  | "fallback"
  | "done";
type JobStatus =
  | "queued"
  | "preparing"
  | "processing"
  | "fallback"
  | "done"
  | "error";
type WarmStatus = "idle" | "warming" | "ready" | "error";

type CartJob = {
  id: string;
  video: SearchItem;
  choice: DownloadChoice;
  status: JobStatus;
  stage: string;
  detail: string;
  phase: ProgressPhase;
  progress: number;
  useOriginal?: boolean;
  startedAt?: number;
  updatedAt?: number;
  filename?: string;
  downloadUrl?: string;
  error?: string;
};

type WorkerMessage =
  | { type: "READY" }
  | {
      type: "PROGRESS";
      progress: number;
      stage?: string;
      phase?: ProgressPhase;
      detail?: string;
    }
  | { type: "DONE"; buffer: ArrayBuffer; mimeType: string; extension: string }
  | { type: "ERROR"; error: string };

const audioChoices: DownloadChoice[] = [
  { mediaType: "audio", bitrate: "320k" },
  { mediaType: "audio", bitrate: "256k" },
  { mediaType: "audio", bitrate: "128k" },
  { mediaType: "audio", bitrate: "64k" },
];

const videoChoices: DownloadChoice[] = [
  { mediaType: "video", resolution: "1080p" },
  { mediaType: "video", resolution: "720p" },
  { mediaType: "video", resolution: "480p" },
  { mediaType: "video", resolution: "360p" },
];

const CORS_PROXY_URL =
  import.meta.env.VITE_CORS_PROXY_URL ?? "http://127.0.0.1:8787";
const JOB_STORAGE_KEY = "sonicfetch-download-jobs";
const INITIAL_SEARCH_LIMIT = 12;
const SEARCH_LIMIT_STEP = 12;
const MAX_SEARCH_LIMIT = 60;

export default function App() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [jobs, setJobs] = useState<CartJob[]>(() => loadSavedJobs());
  const [isAuto128k, setIsAuto128k] = useState(true);
  const [useOriginalFile, setUseOriginalFile] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchLimit, setSearchLimit] = useState(INITIAL_SEARCH_LIMIT);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [activeVideo, setActiveVideo] = useState<SearchItem | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<DownloadChoice>(
    audioChoices[2],
  );
  const [activeTab, setActiveTab] = useState<"audio" | "video">("audio");
  const [concurrency] = useState(() => detectRecommendedWorkers());
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [warmStatus, setWarmStatus] = useState<WarmStatus>("idle");
  const [warmDetail, setWarmDetail] = useState(
    "FFmpeg đang chờ khởi tạo tự động.",
  );
  const [error, setError] = useState<string | null>(null);

  const jobsRef = useRef<CartJob[]>([]);
  const runningRef = useRef(new Set<string>());
  const queueEnabledRef = useRef(false);
  const preloadWorkerRef = useRef<Worker | null>(null);
  const preloadStartedRef = useRef(false);

  useEffect(() => {
    jobsRef.current = jobs;
    saveJobs(jobs);
  }, [jobs]);

  useEffect(() => {
    queueEnabledRef.current = queueEnabled;
    if (queueEnabled) pumpQueue();
  }, [queueEnabled, concurrency, jobs.length]);

  useEffect(() => {
    warmUpFFmpeg();
    return () => {
      jobsRef.current.forEach((job) => {
        if (job.downloadUrl) URL.revokeObjectURL(job.downloadUrl);
      });
      preloadWorkerRef.current?.terminate();
    };
  }, []);

  const queueStats = useMemo(() => getQueueStats(jobs), [jobs]);
  const completedPercent =
    jobs.length > 0 ? Math.round((queueStats.done / jobs.length) * 100) : 0;
  const canLoadMore =
    Boolean(lastSearchQuery) &&
    !looksLikeUrl(lastSearchQuery) &&
    results.length >= searchLimit &&
    searchLimit < MAX_SEARCH_LIMIT;
  const supportedSummary = useMemo(() => {
    if (!metadata) return "";
    return `${metadata.audio_formats.length} audio stream, ${metadata.video_formats.length} video stream khả dụng`;
  }, [metadata]);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setError(null);
    setIsSearching(true);
    try {
      const nextQuery = query.trim();
      setLastSearchQuery(nextQuery);
      setSearchLimit(INITIAL_SEARCH_LIMIT);
      setResults(await searchVideos(nextQuery, INITIAL_SEARCH_LIMIT));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Không thể tìm kiếm video.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  async function handleLoadMore() {
    if (!lastSearchQuery || isLoadingMore) return;

    const nextLimit = Math.min(
      MAX_SEARCH_LIMIT,
      searchLimit + SEARCH_LIMIT_STEP,
    );
    setError(null);
    setIsLoadingMore(true);
    try {
      setResults(await searchVideos(lastSearchQuery, nextLimit));
      setSearchLimit(nextLimit);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Không tải thêm được kết quả.",
      );
    } finally {
      setIsLoadingMore(false);
    }
  }

  async function handleDownloadClick(video: SearchItem) {
    setError(null);
    if (isAuto128k) {
      addJob(video, { mediaType: "audio", bitrate: "128k" }, useOriginalFile);
      return;
    }

    setActiveVideo(video);
    setMetadata(null);
    setActiveTab("audio");
    setSelectedChoice(audioChoices[2]);
    try {
      setMetadata(await getMetadata(video.url));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Không lấy được danh sách định dạng.",
      );
    }
  }

  function addJob(
    video: SearchItem,
    choice: DownloadChoice,
    useOriginal = useOriginalFile,
  ) {
    const id = `${video.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setJobs((current) => [
      ...current,
      {
        id,
        video,
        choice,
        useOriginal,
        status: "queued",
        stage: "Đang chờ",
        detail: "Đã thêm vào hàng đợi. Bấm Bắt đầu để xử lý.",
        phase: "metadata",
        progress: 0,
      },
    ]);
  }

  function startQueue() {
    setError(null);
    setQueueEnabled(true);
    queueEnabledRef.current = true;
    pumpQueue();
  }

  function pauseQueue() {
    setQueueEnabled(false);
    queueEnabledRef.current = false;
  }

  function pumpQueue() {
    if (!queueEnabledRef.current) return;
    const slots = Math.max(0, concurrency - runningRef.current.size);
    if (slots === 0) return;

    const nextJobs = jobsRef.current
      .filter(
        (job) => job.status === "queued" && !runningRef.current.has(job.id),
      )
      .slice(0, slots);
    nextJobs.forEach((job) => {
      runningRef.current.add(job.id);
      void runJob(job).finally(() => {
        runningRef.current.delete(job.id);
        pumpQueue();
      });
    });
  }

  async function runJob(job: CartJob) {
    const startedAt = Date.now();
    updateJob(job.id, {
      status: "preparing",
      stage: "Đang lấy stream",
      detail: "Backend đang bóc direct stream URL mới nhất.",
      phase: "metadata",
      progress: 2,
      startedAt,
      updatedAt: startedAt,
      error: undefined,
    });

    try {
      const stream = await extractStream(
        job.video.url,
        toBackendFormatId(job.choice),
      );
      updateJob(job.id, {
        status: "processing",
        stage: job.useOriginal ? "Đang tải file gốc" : "Đang chuẩn bị FFmpeg",
        detail: job.useOriginal
          ? "Bỏ qua FFmpeg.wasm để tải nhanh stream gốc."
          : "Đã có stream URL. Đang xử lý trong Web Worker.",
        phase: job.useOriginal ? "download" : "metadata",
        progress: 4,
        updatedAt: Date.now(),
      });
      if (job.useOriginal) {
        await downloadOriginalJob(job, stream);
        return;
      }
      await transcodeJob(job, stream);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Tải xuống thất bại.";
      updateJob(job.id, {
        status: "error",
        stage: "Thất bại",
        detail: message,
        phase: "done",
        progress: 100,
        error: message,
        updatedAt: Date.now(),
      });
    }
  }

  function transcodeJob(job: CartJob, stream: ExtractStreamResponse) {
    return new Promise<void>((resolve) => {
      const worker = new Worker(
        new URL("./workers/transcode.worker.ts", import.meta.url),
        { type: "module" },
      );

      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.type === "PROGRESS") {
          updateJob(job.id, {
            status: "processing",
            stage: message.stage ?? "Đang xử lý",
            detail:
              message.detail ?? phaseWaitHint(message.phase ?? "transcode"),
            phase: message.phase ?? "transcode",
            progress: clampProgress(message.progress),
            updatedAt: Date.now(),
          });
          return;
        }

        if (message.type === "ERROR") {
          worker.terminate();
          void fallbackOriginal(job, stream, message.error).finally(resolve);
          return;
        }

        if (message.type === "DONE") {
          const blob = new Blob([message.buffer], { type: message.mimeType });
          const objectUrl = URL.createObjectURL(blob);
          const filename = safeFilename(
            stream.title || job.video.title,
            message.extension,
          );
          triggerBrowserDownload(objectUrl, filename);
          updateJob(job.id, {
            status: "done",
            stage: "Hoàn tất",
            detail:
              "File đã tạo xong. Nếu browser chưa tự lưu file, bấm Tải file.",
            phase: "done",
            progress: 100,
            filename,
            downloadUrl: objectUrl,
            updatedAt: Date.now(),
          });
          worker.terminate();
          resolve();
        }
      };

      worker.postMessage({
        type: "TRANSCODE",
        streams: stream.streams,
        choice: job.choice,
        corsProxyUrl: CORS_PROXY_URL,
      });
    });
  }

  async function downloadOriginalJob(
    job: CartJob,
    stream: ExtractStreamResponse,
  ) {
    const firstStream = stream.streams[0];
    try {
      updateJob(job.id, {
        status: "processing",
        stage: "Đang tải file gốc",
        detail: "Đang tải trực tiếp stream gốc, không chuyển mã.",
        phase: "download",
        progress: 6,
        updatedAt: Date.now(),
      });
      const blob = await fetchStreamBlob(firstStream.url, (progress) => {
        updateJob(job.id, {
          status: "processing",
          stage: "Đang tải file gốc",
          detail: "Đang tải qua CORS proxy.",
          phase: "download",
          progress: Math.min(98, progress),
          updatedAt: Date.now(),
        });
      });
      const extension =
        firstStream.ext ?? (job.choice.mediaType === "audio" ? "m4a" : "mp4");
      const filename = safeFilename(
        `${stream.title || job.video.title} original`,
        extension,
      );
      const objectUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(objectUrl, filename);
      updateJob(job.id, {
        status: "done",
        stage: "Đã tải file gốc",
        detail:
          "File gốc đã sẵn sàng. Chế độ này nhanh hơn vì không dùng FFmpeg.",
        phase: "done",
        progress: 100,
        filename,
        downloadUrl: objectUrl,
        updatedAt: Date.now(),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Tải file gốc thất bại.";
      updateJob(job.id, {
        status: "error",
        stage: "Thất bại",
        detail: message,
        phase: "done",
        progress: 100,
        error: message,
        updatedAt: Date.now(),
      });
    }
  }

  async function fallbackOriginal(
    job: CartJob,
    stream: ExtractStreamResponse,
    reason: string,
  ) {
    try {
      updateJob(job.id, {
        status: "fallback",
        stage: "FFmpeg chưa sẵn sàng",
        detail: "Đang tải stream gốc thay thế. Lý do: " + reason,
        phase: "fallback",
        progress: 5,
        updatedAt: Date.now(),
      });
      await downloadOriginalJob(job, stream);
    } catch (err) {
      const message = err instanceof Error ? err.message : reason;
      updateJob(job.id, {
        status: "error",
        stage: "Thất bại",
        detail: message,
        phase: "done",
        progress: 100,
        error: message,
        updatedAt: Date.now(),
      });
    }
  }

  function warmUpFFmpeg() {
    if (
      preloadStartedRef.current ||
      warmStatus === "warming" ||
      warmStatus === "ready"
    )
      return;
    preloadStartedRef.current = true;

    setWarmStatus("warming");
    setWarmDetail("Browser đang tải và compile FFmpeg.wasm.");
    const worker = new Worker(
      new URL("./workers/transcode.worker.ts", import.meta.url),
      { type: "module" },
    );
    preloadWorkerRef.current?.terminate();
    preloadWorkerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "PROGRESS") {
        setWarmDetail(
          `${message.stage ?? "Đang khởi tạo"} - ${message.progress}%`,
        );
        return;
      }
      if (message.type === "READY") {
        setWarmStatus("ready");
        setWarmDetail("FFmpeg đã sẵn sàng cho các job cần chuyển mã.");
      }
      if (message.type === "ERROR") {
        setWarmStatus("error");
        setWarmDetail(message.error);
        preloadStartedRef.current = false;
        worker.terminate();
      }
    };
    worker.postMessage({ type: "PRELOAD" });
  }

  function updateJob(id: string, patch: Partial<CartJob>) {
    setJobs((current) =>
      current.map((job) => {
        if (job.id !== id) return job;
        if (
          patch.downloadUrl &&
          job.downloadUrl &&
          job.downloadUrl !== patch.downloadUrl
        ) {
          URL.revokeObjectURL(job.downloadUrl);
        }
        return { ...job, ...patch };
      }),
    );
  }

  function removeJob(id: string) {
    setJobs((current) => {
      const target = current.find((job) => job.id === id);
      if (target?.downloadUrl) URL.revokeObjectURL(target.downloadUrl);
      return current.filter((job) => job.id !== id);
    });
  }

  function clearFinishedJobs() {
    setJobs((current) => {
      current.forEach((job) => {
        if (
          (job.status === "done" || job.status === "error") &&
          job.downloadUrl
        )
          URL.revokeObjectURL(job.downloadUrl);
      });
      return current.filter(
        (job) => job.status !== "done" && job.status !== "error",
      );
    });
  }

  return (
    <main className="min-h-screen bg-[#f7f9fc] text-[#111827]">
      <header className="border-b border-[#e5e7eb] bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#0f766e]">
              SonicFetch
            </p>
            <h1 className="text-xl font-black tracking-normal sm:text-2xl">
              MP3/MP4 Downloader
            </h1>
          </div>
          <div className="hidden items-center gap-2 rounded border border-[#e5e7eb] bg-[#f9fafb] px-3 py-2 text-sm font-bold text-[#4b5563] sm:flex">
            <Cpu className="h-4 w-4 text-[#0f766e]" />
            {concurrency} worker tự động
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-[1600px] gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)_380px] lg:px-8">
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="rounded border border-[#dbe5ef] bg-white p-4 shadow-sm sm:p-5">
            <div className="mb-4">
              <h2 className="text-base font-black text-[#172033]">
                Tùy chọn tải
              </h2>
              <p className="mt-1 text-sm font-semibold text-[#64748b]">
                Thiết lập trước khi thêm media vào giỏ.
              </p>
            </div>
            <div className="grid gap-3">
              <ToggleCard
                checked={isAuto128k}
                onChange={setIsAuto128k}
                title="Tự động MP3 128kbps"
                detail="Thêm bài vào hàng đợi MP3 mặc định."
              />
              <ToggleCard
                checked={useOriginalFile}
                onChange={setUseOriginalFile}
                title="Tải file gốc"
                detail="Bỏ qua FFmpeg để tải nhanh hơn."
              />
            </div>
          </section>
        </aside>

        <div className="min-w-0 space-y-5">
          <section className="rounded border border-[#dbe5ef] bg-white p-4 shadow-sm sm:p-5">
            <form onSubmit={handleSearch}>
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="relative block">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#64748b]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="h-14 w-full rounded border border-[#cbd8e6] bg-[#f8fafc] pl-12 pr-4 text-base font-semibold text-[#172033] outline-none transition placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:bg-white focus:ring-4 focus:ring-[#2563eb]/10"
                    placeholder="Nhập từ khóa hoặc dán URL YouTube"
                  />
                </label>
                <button
                  type="submit"
                  disabled={isSearching}
                  className="inline-flex h-14 items-center justify-center gap-2 rounded bg-[#2563eb] px-7 font-black text-white shadow-[0_12px_24px_rgba(37,99,235,0.24)] transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSearching ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Search className="h-5 w-5" />
                  )}
                  Tìm kiếm
                </button>
              </div>
            </form>
          </section>

          {error && (
            <div className="rounded border border-[#fecaca] bg-[#fff1f2] px-4 py-3 text-sm font-bold text-[#b91c1c]">
              {error}
            </div>
          )}

          <section>
            <div className="mb-4 flex items-end justify-between gap-3">
              <div>
                <p className="text-sm font-black uppercase tracking-[0.12em] text-[#0f766e]">
                  Kết quả
                </p>
                <h2 className="text-2xl font-black text-[#111827]">
                  Danh sách media
                </h2>
              </div>
              <p className="text-sm font-semibold text-[#64748b]">
                {results.length
                  ? `${results.length} kết quả`
                  : "Chưa có kết quả"}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
              {results.length ? (
                results.map((item) => (
                  <article
                    key={`${item.id}-${item.url}`}
                    className="group relative min-h-[360px] overflow-hidden rounded border border-[#dbe5ef] bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-card"
                  >
                    <div className="relative aspect-video overflow-hidden bg-[#dbe5ef]">
                      {item.thumbnail ? (
                        <img
                          src={item.thumbnail}
                          alt=""
                          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                        />
                      ) : null}
                      <div className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs font-black text-white backdrop-blur">
                        {formatDuration(item.duration)}
                      </div>
                    </div>
                    <div className="p-4 pb-20">
                      <h3 className="line-clamp-2 min-h-[48px] text-base font-black leading-6 text-[#111827]">
                        {item.title}
                      </h3>
                      <p className="mt-3 line-clamp-1 text-sm font-semibold text-[#64748b]">
                        {item.channel ?? "Kênh không rõ"}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleDownloadClick(item)}
                      className="absolute bottom-4 right-4 inline-flex h-11 items-center gap-2 rounded bg-[#f97316] px-4 text-sm font-black text-white shadow-[0_12px_24px_rgba(249,115,22,0.25)] transition hover:bg-[#ea580c]"
                    >
                      <PlusCircle className="h-4 w-4" />
                      Thêm
                    </button>
                  </article>
                ))
              ) : (
                <div className="col-span-full rounded border border-dashed border-[#cbd5e1] bg-white px-5 py-14 text-center shadow-sm">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded bg-[#eef4fb] text-[#2563eb]">
                    <Search className="h-7 w-7" />
                  </div>
                  <p className="font-black text-[#172033]">
                    Nhập từ khóa hoặc URL để bắt đầu
                  </p>
                  <p className="mt-2 text-sm text-[#64748b]">
                    Kết quả sẽ hiển thị dạng card để bạn thêm vào giỏ tải.
                  </p>
                </div>
              )}
            </div>
            {results.length > 0 ? (
              <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                {canLoadMore ? (
                  <button
                    onClick={() => void handleLoadMore()}
                    disabled={isLoadingMore}
                    className="inline-flex h-12 items-center justify-center gap-2 rounded border border-[#cbd8e6] bg-white px-5 text-sm font-black text-[#172033] shadow-sm transition hover:border-[#2563eb] hover:bg-[#f8fafc] disabled:cursor-wait disabled:opacity-70"
                  >
                    {isLoadingMore ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlusCircle className="h-4 w-4 text-[#2563eb]" />
                    )}
                    Tải thêm
                  </button>
                ) : null}
                <span className="text-sm font-bold text-[#64748b]">
                  Đang hiển thị {results.length} kết quả
                  {!looksLikeUrl(lastSearchQuery)
                    ? ` / tối đa ${MAX_SEARCH_LIMIT}`
                    : ""}
                </span>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="min-w-0 space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="rounded border border-[#dbe5ef] bg-white shadow-card">
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-3 gap-2">
                <MiniStat
                  icon={<ShoppingCart className="h-4 w-4" />}
                  label="Chờ"
                  value={String(queueStats.queued)}
                />
                <MiniStat
                  icon={<Activity className="h-4 w-4" />}
                  label="Đang chạy"
                  value={String(queueStats.running)}
                />
                <MiniStat
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  label="Xong"
                  value={String(queueStats.done)}
                />
              </div>
              <div className="rounded bg-[#f8fafc] p-3">
                <div className="mb-2 flex items-center justify-between text-xs font-black uppercase tracking-[0.12em] text-[#64748b]">
                  <span>Tiến độ hàng đợi</span>
                  <span>{completedPercent}%</span>
                </div>
                <progress
                  className="range-progress h-2.5 w-full overflow-hidden rounded-full"
                  value={completedPercent}
                  max={100}
                />
              </div>
              <div className="grid gap-2">
                <button
                  onClick={queueEnabled ? pauseQueue : startQueue}
                  disabled={
                    !queueEnabled &&
                    !jobs.some((job) => job.status === "queued")
                  }
                  className="inline-flex h-12 items-center justify-center gap-2 rounded bg-[#0f766e] text-sm font-black text-white shadow-[0_12px_24px_rgba(15,118,110,0.24)] transition hover:bg-[#115e59] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {queueEnabled ? (
                    <Pause className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {queueEnabled ? "Tạm dừng sau job hiện tại" : "Bắt đầu xử lý"}
                </button>
                <button
                  onClick={clearFinishedJobs}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded border border-[#fecaca] bg-[#fff7f7] text-sm font-black text-[#b91c1c] transition hover:bg-[#fff1f2]"
                >
                  <Trash2 className="h-4 w-4" />
                  Xóa job xong/lỗi
                </button>
              </div>
              <div className="rounded bg-[#f8fafc] px-3 py-2 text-xs font-semibold leading-5 text-[#64748b]">
                <span className="font-black text-[#172033]">Worker:</span>{" "}
                {concurrency} worker tự động
              </div>
            </div>
          </section>
          <section className="max-h-[calc(100vh-390px)] min-h-[260px] space-y-3 overflow-y-auto pr-1">
            {jobs.length === 0 ? (
              <div className="rounded border border-dashed border-[#cbd5e1] bg-white p-5 text-center text-sm font-semibold text-[#64748b]">
                Chưa có bài nào trong giỏ.
              </div>
            ) : (
              jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onRemove={() => removeJob(job.id)}
                />
              ))
            )}
          </section>
        </aside>
      </section>

      {activeVideo && !isAuto128k && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded border border-[#e5e7eb] bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-[#e5e7eb] p-5">
              <div>
                <h2 className="text-lg font-black">Chọn chất lượng</h2>
                <p className="mt-1 line-clamp-1 text-sm font-semibold text-[#6b7280]">
                  {activeVideo.title}
                </p>
              </div>
              <button
                onClick={() => setActiveVideo(null)}
                className="rounded p-2 text-[#6b7280] hover:bg-[#f3f4f6]"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5">
              <div className="grid grid-cols-2 gap-2 rounded bg-[#f3f4f6] p-1">
                <button
                  onClick={() => {
                    setActiveTab("audio");
                    setSelectedChoice(audioChoices[2]);
                  }}
                  className={`inline-flex items-center justify-center gap-2 rounded px-4 py-3 font-black ${activeTab === "audio" ? "bg-white text-[#0f766e] shadow-sm" : "text-[#6b7280]"}`}
                >
                  <Music2 className="h-4 w-4" />
                  Audio
                </button>
                <button
                  onClick={() => {
                    setActiveTab("video");
                    setSelectedChoice(videoChoices[1]);
                  }}
                  className={`inline-flex items-center justify-center gap-2 rounded px-4 py-3 font-black ${activeTab === "video" ? "bg-white text-[#2563eb] shadow-sm" : "text-[#6b7280]"}`}
                >
                  <Video className="h-4 w-4" />
                  Video
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(activeTab === "audio" ? audioChoices : videoChoices).map(
                  (choice) => {
                    const label =
                      choice.mediaType === "audio"
                        ? choice.bitrate
                        : choice.resolution;
                    const selected =
                      choice.mediaType === selectedChoice.mediaType &&
                      choice.bitrate === selectedChoice.bitrate &&
                      choice.resolution === selectedChoice.resolution;
                    return (
                      <button
                        key={`${choice.mediaType}-${label}`}
                        onClick={() => setSelectedChoice(choice)}
                        className={`rounded border px-3 py-3 text-center font-black ${selected ? "border-[#2563eb] bg-[#eff6ff] text-[#1d4ed8]" : "border-[#d1d5db] bg-white text-[#374151] hover:bg-[#f9fafb]"}`}
                      >
                        {label}
                      </button>
                    );
                  },
                )}
              </div>

              <div className="mt-4 rounded bg-[#f9fafb] px-3 py-2 text-sm font-semibold text-[#6b7280]">
                {metadata
                  ? supportedSummary
                  : "Đang đọc supported_formats từ backend..."}
              </div>
              <button
                disabled={!metadata}
                onClick={() => {
                  addJob(activeVideo, selectedChoice, useOriginalFile);
                  setActiveVideo(null);
                }}
                className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded bg-[#0f766e] font-black text-white transition hover:bg-[#115e59] disabled:cursor-wait disabled:opacity-60"
              >
                <ShoppingCart className="h-5 w-5" />
                Thêm vào hàng đợi
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ToggleCard({
  checked,
  onChange,
  title,
  detail,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between gap-4 rounded border p-4 transition ${checked ? "border-[#b7d8d3] bg-[#f2fbf9]" : "border-[#e5e7eb] bg-[#f9fafb]"}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-black">{title}</div>
          <span
            className={`rounded px-2 py-0.5 text-xs font-black ${checked ? "bg-[#ccfbf1] text-[#0f766e]" : "bg-[#e5e7eb] text-[#4b5563]"}`}
          >
            {checked ? "Bật" : "Tắt"}
          </span>
        </div>
        <div className="mt-1 text-sm font-semibold leading-5 text-[#6b7280]">
          {detail}
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="relative h-7 w-12 shrink-0 rounded-full bg-[#d1d5db] ring-1 ring-inset ring-[#cbd5e1] transition peer-checked:bg-[#0f766e] peer-checked:ring-[#0f766e] after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition peer-checked:after:translate-x-5" />
    </label>
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded bg-[#f8fafc] p-3">
      <div className="mb-2 text-[#2563eb]">{icon}</div>
      <div className="text-lg font-black text-[#111827]">{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[#64748b]">
        {label}
      </div>
    </div>
  );
}

function StatusCard({
  icon,
  title,
  detail,
  accent,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  accent: string;
}) {
  return (
    <div className="rounded border border-[#e5e7eb] bg-white p-4 shadow-sm">
      <div className={`mb-2 inline-flex ${accent}`}>{icon}</div>
      <div className="font-black">{title}</div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold text-[#6b7280]">
        {detail}
      </div>
    </div>
  );
}

function JobRow({ job, onRemove }: { job: CartJob; onRemove: () => void }) {
  const timing = getProgressTiming(job);
  const canRemove =
    job.status === "queued" || job.status === "done" || job.status === "error";
  const FormatIcon = job.choice.mediaType === "audio" ? Music2 : Video;

  return (
    <div className="grid gap-3 rounded border border-[#e5e7eb] bg-white p-3 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-2 py-1 text-xs font-black ${statusClass(job.status)}`}
          >
            {statusLabel(job.status)}
          </span>
          <span className="inline-flex items-center gap-1 rounded bg-[#f3f4f6] px-2 py-1 text-xs font-black text-[#4b5563]">
            <FormatIcon className="h-3.5 w-3.5" />
            {jobChoiceLabel(job)}
          </span>
        </div>
        <h3 className="line-clamp-1 font-black">{job.video.title}</h3>
        <p className="mt-1 line-clamp-1 text-sm font-semibold text-[#6b7280]">
          {job.stage} - {job.detail}
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-black text-[#6b7280]">
          <span>{phaseLabel(job.phase)}</span>
          <span>{job.progress}%</span>
        </div>
        <progress
          className="range-progress h-2.5 w-full overflow-hidden rounded-full"
          value={job.progress}
          max={100}
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-xs font-bold text-[#6b7280]">
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3.5 w-3.5" />
            {timing.elapsed}
          </span>
          <span className="inline-flex items-center gap-1">
            <Activity className="h-3.5 w-3.5" />
            {timing.eta}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          {job.downloadUrl && job.filename ? (
            <a
              href={job.downloadUrl}
              download={job.filename}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded bg-[#2563eb] text-sm font-black text-white"
            >
              <FileDown className="h-4 w-4" />
              Tải file
            </a>
          ) : null}
          <button
            onClick={onRemove}
            disabled={!canRemove}
            className="inline-flex h-9 w-10 items-center justify-center rounded border border-[#e5e7eb] text-[#6b7280] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Xóa job"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      {job.error ? (
        <div className="rounded bg-[#fff1f2] px-3 py-2 text-sm font-bold text-[#b91c1c] md:col-span-2">
          {job.error}
        </div>
      ) : null}
    </div>
  );
}

async function fetchStreamBlob(
  streamUrl: string,
  onProgress: (progress: number) => void,
): Promise<Blob> {
  const proxied = `${CORS_PROXY_URL.replace(/\/$/, "")}/?url=${encodeURIComponent(streamUrl)}`;
  const response = await fetch(proxied);
  if (!response.ok)
    throw new Error(`Không tải được stream: ${response.status}`);
  return readResponseBlobWithProgress(response, onProgress);
}

async function readResponseBlobWithProgress(
  response: Response,
  onProgress: (progress: number) => void,
): Promise<Blob> {
  if (!response.body) return response.blob();

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
    if (total > 0) onProgress(Math.round((received / total) * 100));
  }

  const parts = chunks.map((chunk) => Uint8Array.from(chunk).buffer);
  return new Blob(parts, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

function getProgressTiming(job: Pick<CartJob, "startedAt" | "progress">) {
  if (!job.startedAt) return { elapsed: "--", eta: "--" };
  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - job.startedAt) / 1000),
  );
  if (job.progress <= 2 || job.progress >= 100) {
    return {
      elapsed: formatSeconds(elapsedSeconds),
      eta: job.progress >= 100 ? "0s" : "đang tính",
    };
  }
  const estimatedTotal = elapsedSeconds / (job.progress / 100);
  const remaining = Math.max(0, Math.round(estimatedTotal - elapsedSeconds));
  return {
    elapsed: formatSeconds(elapsedSeconds),
    eta: formatSeconds(remaining),
  };
}

function getQueueStats(jobs: CartJob[]) {
  return {
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter(
      (job) =>
        job.status === "preparing" ||
        job.status === "processing" ||
        job.status === "fallback",
    ).length,
    done: jobs.filter((job) => job.status === "done").length,
  };
}

function phaseLabel(phase: ProgressPhase) {
  const labels: Record<ProgressPhase, string> = {
    metadata: "Stream",
    init: "FFmpeg",
    download: "Tải",
    write: "Ghi",
    transcode: "Mã hóa",
    package: "Đóng gói",
    fallback: "Fallback",
    done: "Xong",
  };
  return labels[phase];
}

function phaseWaitHint(phase: ProgressPhase) {
  const hints: Record<ProgressPhase, string> = {
    metadata: "Backend đang bóc URL stream.",
    init: "FFmpeg.wasm đang khởi tạo.",
    download: "Đang tải media qua proxy.",
    write: "Đang nạp dữ liệu vào FFmpeg.",
    transcode: "Đang dùng CPU của browser.",
    package: "Đang tạo file tải xuống.",
    fallback: "Đang tải stream gốc thay thế.",
    done: "Đã xử lý xong.",
  };
  return hints[phase];
}

function statusLabel(status: JobStatus) {
  const labels: Record<JobStatus, string> = {
    queued: "Chờ",
    preparing: "Stream",
    processing: "Đang chạy",
    fallback: "Fallback",
    done: "Xong",
    error: "Lỗi",
  };
  return labels[status];
}

function statusClass(status: JobStatus) {
  const classes: Record<JobStatus, string> = {
    queued: "bg-[#f3f4f6] text-[#4b5563]",
    preparing: "bg-[#fef3c7] text-[#92400e]",
    processing: "bg-[#dbeafe] text-[#1d4ed8]",
    fallback: "bg-[#ffedd5] text-[#c2410c]",
    done: "bg-[#ccfbf1] text-[#0f766e]",
    error: "bg-[#ffe4e6] text-[#be123c]",
  };
  return classes[status];
}

function warmLabel(status: WarmStatus) {
  const labels: Record<WarmStatus, string> = {
    idle: "FFmpeg chờ",
    warming: "FFmpeg đang khởi tạo",
    ready: "FFmpeg sẵn sàng",
    error: "FFmpeg lỗi",
  };
  return labels[status];
}

function choiceLabel(choice: DownloadChoice) {
  return choice.mediaType === "audio"
    ? `MP3 ${choice.bitrate ?? "128k"}`
    : `MP4 ${choice.resolution ?? "720p"}`;
}

function jobChoiceLabel(job: CartJob) {
  return job.useOriginal
    ? `Gốc ${job.choice.mediaType === "audio" ? "audio" : "video"}`
    : choiceLabel(job.choice);
}

function formatSeconds(totalSeconds: number) {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function clampProgress(progress: number) {
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function detectRecommendedWorkers() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory =
    "deviceMemory" in navigator
      ? Number(
          (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        )
      : 4;

  if (cores >= 12 && memory >= 12) return 3;
  if (cores >= 8 && memory >= 8) return 2;
  return 1;
}

function toBackendFormatId(choice: DownloadChoice): string {
  if (choice.mediaType === "audio")
    return `mp3_${choice.bitrate?.replace("k", "") ?? "128"}`;
  return `mp4_${choice.resolution ?? "720p"}`;
}

function looksLikeUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function triggerBrowserDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
  }, 1000);
}

function loadSavedJobs(): CartJob[] {
  try {
    const raw = window.localStorage.getItem(JOB_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CartJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((job) => {
      if (
        job.status === "preparing" ||
        job.status === "processing" ||
        job.status === "fallback"
      ) {
        return {
          ...job,
          status: "queued",
          stage: "Đã khôi phục",
          detail:
            "Trang vừa được tải lại. Job được đưa về hàng chờ để xử lý lại.",
          phase: "metadata",
          progress: 0,
          startedAt: undefined,
          updatedAt: undefined,
          downloadUrl: undefined,
        };
      }
      return { ...job, downloadUrl: undefined };
    });
  } catch {
    return [];
  }
}

function saveJobs(jobs: CartJob[]) {
  try {
    const serializable = jobs.map(
      ({ downloadUrl: _downloadUrl, ...job }) => job,
    );
    window.localStorage.setItem(JOB_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // Queue still works in memory when localStorage is unavailable.
  }
}
