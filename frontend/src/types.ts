export type SearchItem = {
  id: string;
  url: string;
  title: string;
  thumbnail?: string | null;
  duration?: number | null;
  channel?: string | null;
};

export type FormatItem = {
  format_id: string;
  label: string;
  ext?: string | null;
  type: "audio" | "video";
  abr?: number | null;
  vbr?: number | null;
  height?: number | null;
  fps?: number | null;
  filesize?: number | null;
  has_audio: boolean;
  has_video: boolean;
};

export type Metadata = {
  id: string;
  url: string;
  title: string;
  thumbnail?: string | null;
  duration?: number | null;
  channel?: string | null;
  audio_formats: FormatItem[];
  video_formats: FormatItem[];
};

export type StreamPart = {
  kind: "audio" | "video";
  url: string;
  ext?: string | null;
  format_id: string;
};

export type ExtractStreamResponse = {
  title: string;
  requested_format: string;
  stream_url: string;
  streams: StreamPart[];
};

export type DownloadChoice = {
  mediaType: "audio" | "video";
  bitrate?: "320k" | "256k" | "128k" | "64k";
  resolution?: "1080p" | "720p" | "480p" | "360p";
  formatId?: string;
  label?: string;
  ext?: string | null;
  filesize?: number | null;
  hasAudio?: boolean;
  hasVideo?: boolean;
};

export type DiagnosticStatus = "checking" | "ok" | "warning" | "error";

export type DiagnosticItem = {
  id: string;
  label: string;
  detail: string;
  status: DiagnosticStatus;
};
