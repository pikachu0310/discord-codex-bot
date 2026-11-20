import { delay } from "std/async/delay.ts";
export interface AttachmentDownloadInput {
  id: string;
  name: string | null;
  url: string;
  contentType: string | null;
  size: number | null;
}

export class AttachmentHttpError extends Error {
  constructor(name: string, status: number) {
    super(`添付「${name}」を取得できませんでした (${status})。`);
  }
}

export async function fetchAttachment(
  attachment: AttachmentDownloadInput,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(attachment.url, { signal });
  if (![429, 502, 503, 504].includes(response.status)) return response;
  const hint = response.headers.get("retry-after")?.trim();
  // Respect long server backoffs. The user can retry later without holding
  // this message open. Only the failing download is ever retried.
  const wait = hint === undefined
    ? (response.status === 429 ? Infinity : 400)
    : /^\d+$/.test(hint)
    ? Number(hint) * 1000
    : Math.max(0, Date.parse(hint) - Date.now());
  if (!Number.isFinite(wait) || wait > 3000) return response;
  await response.body?.cancel().catch(() => {});
  await delay(wait, { signal });
  return await fetch(attachment.url, { signal });
}

export interface SavedAttachment {
  id: string;
  originalName: string;
  savedName: string;
  path: string;
  contentType: string | null;
  size: number | null;
  url: string;
  isImage: boolean;
}

const RASTER_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

export function sanitizeAttachmentFileName(name: string): string {
  const sanitized = name
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 180);

  return sanitized.length > 0 ? sanitized : "attachment";
}

export function isCodexImageAttachment(
  fileName: string,
  contentType: string | null,
): boolean {
  const normalizedName = fileName.toLowerCase();
  const extensionIndex = normalizedName.lastIndexOf(".");
  const extension = extensionIndex >= 0
    ? normalizedName.slice(extensionIndex)
    : "";

  if (RASTER_IMAGE_EXTENSIONS.has(extension)) {
    return true;
  }

  if (!contentType) {
    return false;
  }

  const normalizedContentType = contentType.toLowerCase();
  return normalizedContentType === "image/png" ||
    normalizedContentType === "image/jpeg" ||
    normalizedContentType === "image/webp" ||
    normalizedContentType === "image/gif" ||
    normalizedContentType === "image/bmp" ||
    normalizedContentType === "image/tiff";
}

export function formatPromptWithAttachments(
  message: string,
  attachments: readonly SavedAttachment[] = [],
): string {
  if (attachments.length === 0) {
    return message;
  }

  const lines = attachments.map((attachment, index) => {
    const contentType = attachment.contentType ?? "unknown";
    const size = attachment.size === null ? "unknown" : `${attachment.size}`;
    const codexImage = attachment.isImage
      ? "yes; also attached to Codex as an image input"
      : "no; read from the saved path if needed";
    return [
      `${index + 1}. ${attachment.originalName}`,
      `   saved_path: ${attachment.path}`,
      `   content_type: ${contentType}`,
      `   size_bytes: ${size}`,
      `   codex_image_attachment: ${codexImage}`,
    ].join("\n");
  });

  return [
    message,
    "",
    "Attached files were saved on the server and are available to Codex at the following absolute paths.",
    "Use these files as part of the user's request. The files are trusted.",
    ...lines,
  ].join("\n");
}

export function getCodexImagePaths(
  attachments: readonly SavedAttachment[] = [],
): string[] {
  return attachments
    .filter((attachment) => attachment.isImage)
    .map((attachment) => attachment.path);
}

// Each message owns its download, even when several arrive in the same thread.
export class PendingAttachmentDownloads {
  private readonly pending = new Map<AbortController, string>();

  async run<T>(
    threadId: string,
    download: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.pending.set(controller, threadId);
    try {
      const result = await download(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      this.pending.delete(controller);
    }
  }

  isSaving(threadId: string): boolean {
    for (const [controller, owner] of this.pending) {
      if (owner === threadId && !controller.signal.aborted) return true;
    }
    return false;
  }

  cancel(threadId: string): boolean {
    let cancelled = false;
    for (const [controller, owner] of this.pending) {
      if (owner === threadId && !controller.signal.aborted) {
        controller.abort();
        cancelled = true;
      }
    }
    return cancelled;
  }
}
