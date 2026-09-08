// Image prep for vision upload.
//
// A phone photo (3-5MB) base64-encodes to millions of characters. The provider
// counts that against the request, so a full-size photo empties even a healthy
// key (402) or trips provider size limits — even for a trivial question.
// Downscale raster images to a bounded JPEG before upload. PDFs/CSVs pass
// through untouched (server-side parsing, no pixel cost).
//
// Electron's nativeImage does the resize with no new dependencies. Backend
// must stay importable without Electron (tests, tooling), so the loader
// falls back to the original bytes when Electron is unavailable.
const MAX_EDGE_PX = 1568;
const JPEG_QUALITY = 80;
const PASSTHROUGH_BYTES = 900 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export interface PreparedImage {
  buffer: Buffer;
  mediaType: string;
  resized: boolean;
  originalBytes: number;
  finalBytes: number;
}

interface NativeImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: string }): NativeImage;
  toJPEG(quality: number): Buffer;
}

async function loadNativeImage(): Promise<{ createFromBuffer(buffer: Buffer): NativeImage } | undefined> {
  try {
    const loader = new Function("name", "return import(name)") as (name: string) => Promise<{
      nativeImage?: { createFromBuffer(buffer: Buffer): NativeImage };
      default?: { nativeImage?: { createFromBuffer(buffer: Buffer): NativeImage } };
    }>;
    const electron = await loader("electron");
    return electron?.nativeImage ?? electron?.default?.nativeImage;
  } catch {
    return undefined;
  }
}

export async function prepareImage(input: Buffer, mediaType: string): Promise<PreparedImage> {
  const passthrough = (): PreparedImage => ({
    buffer: input,
    mediaType,
    resized: false,
    originalBytes: input.length,
    finalBytes: input.length,
  });
  // Non-raster or animated/vector formats: never transcode, only size-guard.
  if (!mediaType.startsWith("image/") || mediaType === "image/svg+xml" || mediaType === "image/gif")
    return passthrough();
  if (input.length <= PASSTHROUGH_BYTES) return passthrough();
  const factory = await loadNativeImage();
  if (!factory) return passthrough();
  try {
    const image = factory.createFromBuffer(input);
    if (image.isEmpty()) return passthrough();
    const { width, height } = image.getSize();
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height, 1));
    const fitted =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: "better",
          })
        : image;
    const jpeg = fitted.toJPEG(JPEG_QUALITY);
    if (!jpeg.length || jpeg.length >= input.length) return passthrough();
    return { buffer: jpeg, mediaType: "image/jpeg", resized: true, originalBytes: input.length, finalBytes: jpeg.length };
  } catch {
    return passthrough();
  }
}

export function assertUploadableSize(finalBytes: number): void {
  if (finalBytes > MAX_UPLOAD_BYTES)
    throw new Error(
      `image too large to send (${(finalBytes / 1048576).toFixed(1)}MB after processing, limit 5MB); attach a smaller file`,
    );
}
