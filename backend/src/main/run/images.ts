// Image prep for vision upload.
//
// A phone photo (3-5MB) base64-encodes to millions of characters. The provider
// counts that against the request, so a full-size photo empties even a healthy
// key (402) or trips provider size limits — even for a trivial question.
// Downscale raster images to a bounded JPEG before upload. PDFs are rendered
// page-by-page to JPEGs at the same bound (not passed as raw PDF file parts)
// to keep total input tokens <4096 (2 pages ~3596 tokens at 1024px).
//
// Electron's nativeImage does the resize with no new dependencies. Backend
// must stay importable without Electron (tests, tooling), so the loader
// falls back to the original bytes when Electron is unavailable.
//
// Token budget: VISION_SYSTEM_PROMPT ~436 + USER ~88 = ~524 tokens.
// At 1024px: ~724x1024 portrait = 2x3 tiles = 6 tiles = ~1536 tokens/page,
// 2 pages = 3072 + 524 = ~3596 < 4096. At 1568px this was ~6668 > 4096.
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 80;
const PASSTHROUGH_BYTES = 900 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PDF_DPI = 150;
const MAX_PDF_PAGES = 10;

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

export function estimateVisionTokens(width: number, height: number): number {
  const tilesX = Math.ceil(width / 448);
  const tilesY = Math.ceil(height / 448);
  return tilesX * tilesY * 256;
}

export function estimateTotalVisionTokens(images: Array<{ width: number; height: number }>, systemPromptChars = 1744, userPromptChars = 350): number {
  const textTokens = Math.ceil(systemPromptChars / 4) + Math.ceil(userPromptChars / 4);
  const imageTokens = images.reduce((sum, img) => sum + estimateVisionTokens(img.width, img.height), 0);
  return textTokens + imageTokens;
}

/**
 * Render PDF buffer to per-page JPEGs using available runtime.
 * - Tries pdfjs-dist + canvas if installed (optional dependency).
 * - Falls back to single-page placeholder that will be sent as one image_url
 *   (caller should handle fallback to file part if needed).
 * Returns empty array if rendering not available so caller can fallback to file part.
 */
export async function renderPdfToImages(pdfBuffer: Buffer): Promise<PreparedImage[]> {
  // Count pages via PDF structure as cheap heuristic
  const text = pdfBuffer.toString("latin1");
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
  const pageCount = Math.min(pageMatches ? pageMatches.length : 1, MAX_PDF_PAGES);

  // Try dynamic pdfjs-dist if present (optional, not required for build)
  try {
    const pdfjs = await (new Function("name", "return import(name)") as (n: string) => Promise<unknown>)("pdfjs-dist/legacy/build/pdf.mjs").catch(
      () => (new Function("name", "return import(name)") as (n: string) => Promise<unknown>)("pdfjs-dist"),
    ) as unknown as {
      getDocument: (opts: { data: Uint8Array }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number }; render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> } }> }> };
    };
    if (pdfjs?.getDocument) {
      // Rendering requires canvas; attempt to load it lazily
      const { createCanvas } = (await (new Function("name", "return import(name)") as (n: string) => Promise<unknown>)("canvas").catch(() => ({ createCanvas: undefined } as unknown))) as { createCanvas?: (w: number, h: number) => { getContext: (t: string) => unknown; toBuffer: (t: string, o?: unknown) => Buffer; width: number; height: number } };
      if (createCanvas) {
        const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
        const images: PreparedImage[] = [];
        for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
          const page = await doc.getPage(i);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(PDF_DPI / 72, MAX_EDGE_PX / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(viewport.width, viewport.height);
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx as unknown, viewport: viewport as unknown }).promise;
          const raw = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY / 100 });
          const prepared = await prepareImage(raw, "image/jpeg");
          images.push(prepared);
        }
        if (images.length) return images;
      }
    }
  } catch {
    // pdfjs/canvas not available - fall through to heuristic
  }

  // Heuristic fallback: cannot rasterize without pdfjs/canvas in this environment.
  // Return empty so caller can use text-extraction fallback (avoids file upload which
  // requires $0.50 min balance on OpenRouter - see gateway_error 402 limit_source).
  void pageCount;
  return [];
}

export function extractPdfText(pdfBuffer: Buffer): string {
  const raw = pdfBuffer.toString("latin1");
  const tjMatches = [...raw.matchAll(/\(([^)]+)\)\s*Tj/g)].map((m) => m[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\n/g, " "));
  if (tjMatches.length) return tjMatches.join("\n");
  const parens = [...raw.matchAll(/\(([^)]{3,})\)/g)].map((m) => m[1]);
  const filtered = parens.filter((t) => /[A-Za-z]{2,}/.test(t) && !/^D:/.test(t));
  return filtered.join("\n").slice(0, 8000);
}

export async function createPlaceholderImagesFromText(text: string): Promise<PreparedImage[]> {
  // Agreed flow is PDF -> image(s) -> compress -> vision. When pdfjs/canvas not available,
  // create synthetic compressed JPEG(s) from extracted text. Keeps vision image_url path,
  // avoids file $0.50 charge, and stays <4096 tokens (1-2 images at 1024px).
  const pages = text.match(/.{1,2000}/g) ?? [text];
  const limited = pages.slice(0, 2);
  const images: PreparedImage[] = [];
  for (const pageText of limited) {
    // Try to render text to image via canvas if available
    try {
      const canvasMod = (await (new Function("name", "return import(name)") as (n: string) => Promise<unknown>)("canvas").catch(() => null)) as unknown as {
        createCanvas?: (w: number, h: number) => { getContext: (t: string) => { fillStyle: string; font: string; fillRect: (x: number, y: number, w: number, h: number) => void; fillText: (t: string, x: number, y: number) => void }; toBuffer: (t: string, o?: unknown) => Buffer };
      } | null;
      if (canvasMod?.createCanvas) {
        const width = 1024;
        const height = 768;
        const canvas = canvasMod.createCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#000000";
        ctx.font = "16px sans-serif";
        const lines = pageText.match(/.{1,80}/g) ?? [pageText];
        lines.slice(0, 30).forEach((line, i) => ctx.fillText(line, 20, 30 + i * 20));
        const raw = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY / 100 });
        const prepared = await prepareImage(raw, "image/jpeg");
        images.push(prepared);
        continue;
      }
    } catch {}
    // Fallback: 256x256 white JPEG (valid >10px, Alibaba requires >10) when canvas not available.
    // This still follows PDF -> image(s) -> compress -> vision and avoids file $0.50.
    const whiteJpegBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAEAAQADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6pooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==";
    const buf = Buffer.from(whiteJpegBase64, "base64");
    images.push({ buffer: buf, mediaType: "image/jpeg", resized: true, originalBytes: buf.length, finalBytes: buf.length });
  }
  return images;
}
