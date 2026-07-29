import type { DownloadChoice, FormatItem } from "./types";

export function toBackendFormatId(choice: DownloadChoice): string {
  if (choice.formatId) return choice.formatId;
  if (choice.mediaType === "audio") {
    return `mp3_${choice.bitrate?.replace("k", "") ?? "128"}`;
  }
  return `mp4_${choice.resolution ?? "720p"}`;
}

export function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return "Không rõ dung lượng";
  const units = ["B", "KB", "MB", "GB"];
  let next = value;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 || unit === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

export function audioFormatChoice(format: FormatItem): DownloadChoice {
  return {
    mediaType: "audio",
    formatId: format.format_id,
    label: `${format.label} ${format.ext ?? ""}`.trim(),
    ext: format.ext,
    filesize: format.filesize,
    hasAudio: format.has_audio,
    hasVideo: format.has_video,
  };
}

export function videoFormatChoice(format: FormatItem): DownloadChoice {
  return {
    mediaType: "video",
    formatId: format.format_id,
    label: `${format.label} ${format.ext ?? ""}`.trim(),
    ext: format.ext,
    filesize: format.filesize,
    hasAudio: format.has_audio,
    hasVideo: format.has_video,
  };
}
