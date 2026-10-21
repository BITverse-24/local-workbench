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
import { createHash } from 'node:crypto';
import { assertRuntimeActive } from './runtime-scope.js';
const MAX_EDGE_PX = 1280;
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

async function importOptional<T = unknown>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as T;
  } catch {
    return undefined;
  }
}

async function loadNativeImage(): Promise<{ createFromBuffer(buffer: Buffer): NativeImage } | undefined> {
  try {
    const electron = await importOptional<{
      nativeImage?: { createFromBuffer(buffer: Buffer): NativeImage };
      default?: { nativeImage?: { createFromBuffer(buffer: Buffer): NativeImage } };
    }>("electron");
    return electron?.nativeImage ?? electron?.default?.nativeImage;
  } catch {
    return undefined;
  }
}

async function loadPdfJs(): Promise<any> {
  const legacy = await importOptional<any>("pdfjs-dist/legacy/build/pdf.mjs");
  if (legacy) return legacy;
  return await importOptional<any>("pdfjs-dist");
}

async function loadCanvas(): Promise<{ createCanvas?: (w: number, h: number) => any; loadImage?: (input: Buffer) => Promise<any> } | undefined> {
  const canvasMod = await importOptional<any>("canvas");
  return canvasMod?.createCanvas ? canvasMod : canvasMod?.default;
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
 * If pageNumbers is provided, only the specified 1-based pages are rendered.
 * Returns empty array if rendering not available so caller can fallback.
 */
export async function renderPdfToImages(pdfBuffer: Buffer, pageNumbers?: number[]): Promise<PreparedImage[]> {
  // Count pages via PDF structure as cheap heuristic
  const text = pdfBuffer.toString("latin1");
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
  const pageCount = Math.min(pageMatches ? pageMatches.length : 1, MAX_PDF_PAGES);

  // Try dynamic pdfjs-dist and canvas if present (optional, not required for build)
  try {
    const pdfjs = await loadPdfJs();
    if (pdfjs?.getDocument) {
      const canvasMod = await loadCanvas();
      const createCanvas = canvasMod?.createCanvas;
      if (createCanvas) {
        const renderCanvas = createCanvas;
        // PDF.js must use the same canvas implementation for intermediate image
        // decoding and the destination. Mixing native canvas backends fails on scans.
        class LocalCanvasFactory {
          create(width: number, height: number) {
            const canvas = renderCanvas(width, height);
            return { canvas, context: canvas.getContext("2d") };
          }
          reset(target: any, width: number, height: number) { target.canvas.width = width; target.canvas.height = height; }
          destroy(target: any) { target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null; }
        }
        const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), CanvasFactory: LocalCanvasFactory }).promise;
        const targetPages = pageNumbers && pageNumbers.length > 0
          ? pageNumbers.filter((p) => p >= 1 && p <= doc.numPages)
          : Array.from({ length: Math.min(doc.numPages, MAX_PDF_PAGES) }, (_, i) => i + 1);

        const images: PreparedImage[] = [];
        for (const i of targetPages) {
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
  } catch (error) {
    console.warn("PDF source rendering failed:", error instanceof Error ? error.message : String(error));
  }

  void pageCount;
  return [];
}

/** Rasterize the actual SVG, including geometry and embedded images. */
export async function renderSvgToImage(raw: Buffer): Promise<PreparedImage> {
  const canvasModule = await loadCanvas();
  if (!canvasModule?.createCanvas || !canvasModule.loadImage) throw new Error("SVG visual extraction requires a local image renderer.");
  const image = await canvasModule.loadImage(raw);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(image.width, image.height, 1));
  const canvas = canvasModule.createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const buffer = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY / 100 });
  return { buffer, mediaType: "image/jpeg", resized: true, originalBytes: raw.length, finalBytes: buffer.length };
}

export interface SourceView { page: number; location: string; buffer: Buffer; }
export interface VisualDocument {
  pageViewCounts: number[];
  render(page: number): Promise<SourceView[]>;
  close(): Promise<void>;
}
const sourceViewCache = new Map<string,SourceView[]>();
let sourceViewCacheBytes=0;

/** Plan every source page before rendering. Never substitute extracted text for pixels. */
export async function openVisualDocument(raw: Buffer, extension: string): Promise<VisualDocument> {
  assertRuntimeActive();
  if(extension==='svg') {
    const xml=raw.toString('utf8');
    if(/<!DOCTYPE|<!ENTITY/i.test(xml)||[...xml.matchAll(/(?:\b(?:xlink:)?href\s*=\s*["']([^"']+)["']|\burl\(\s*["']?([^\s)"']+))/gi)].some(match=>!/^#|^data:image\/(?:png|jpeg|webp|bmp|gif);base64,/i.test(match[1]??match[2])))throw new Error('SVG inspection requires self-contained source images. External resources and XML entities are not supported.');
  }
  const sourceKey=createHash('sha256').update(raw).update(extension+':150dpi:1024:128:v1').digest('hex');
  const canvasMod = await loadCanvas();
  if (!canvasMod?.createCanvas || !canvasMod.loadImage) throw new Error('Source inspection requires the local image renderer.');
  const { createCanvas, loadImage } = canvasMod;
  let pdf: any;
  let raster: any;
  const sizes: Array<{width:number;height:number}> = [];
  if (extension === 'pdf') {
    const pdfjs = await loadPdfJs();
    if (!pdfjs?.getDocument) throw new Error('Source inspection requires the PDF renderer.');
    class CanvasFactory {
      create(width:number,height:number) { const canvas=createCanvas!(width,height);return {canvas,context:canvas.getContext('2d')}; }
      reset(target:any,width:number,height:number) { target.canvas.width=width;target.canvas.height=height; }
      destroy(target:any) { target.canvas.width=0;target.canvas.height=0;target.canvas=null;target.context=null; }
    }
    pdf=await pdfjs.getDocument({data:new Uint8Array(raw),CanvasFactory}).promise;
    for(let page=1;page<=pdf.numPages;page++) {
      assertRuntimeActive();
      const vp=(await pdf.getPage(page)).getViewport({scale:PDF_DPI/72});
      sizes.push({width:Math.ceil(vp.width),height:Math.ceil(vp.height)});
    }
  } else {
    raster=await loadImage(raw);sizes.push({width:raster.width,height:raster.height});
  }
  const offsets=(size:number):number[]=> {
    if(size<=MAX_EDGE_PX)return [0];
    const values:number[]=[];
    for(let start=0;start<size;start+=MAX_EDGE_PX-128){values.push(Math.min(start,size-MAX_EDGE_PX));if(start+MAX_EDGE_PX>=size)break;}
    return [...new Set(values)];
  };
  const count=({width,height}:{width:number;height:number})=>Math.max(width,height)<=MAX_EDGE_PX?1:1+offsets(width).length*offsets(height).length;
  return {
    pageViewCounts:sizes.map(count),
    async close(){await pdf?.destroy?.();},
    async render(page){
      const cacheKey=`${sourceKey}:${page}`;
      const cached=sourceViewCache.get(cacheKey);
      if(cached)return cached;
      const size=sizes[page-1];if(!size)throw new Error('Page is outside the source.');
      if(size.width*size.height>40_000_000)throw new Error('Source page exceeds the rendering limit. Supply a smaller source or region.');
      const canvas=createCanvas(size.width,size.height);const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
      if(pdf){const p=await pdf.getPage(page);await p.render({canvasContext:ctx,viewport:p.getViewport({scale:PDF_DPI/72})}).promise;}
      else ctx.drawImage(raster,0,0);
      const views:SourceView[]=[];
      const add=(x:number,y:number,width:number,height:number,overview=false)=>{
        const scale=overview?Math.min(1,MAX_EDGE_PX/Math.max(width,height)):1;
        const view=createCanvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));
        view.getContext('2d').drawImage(canvas,x,y,width,height,0,0,view.width,view.height);
        views.push({page,location:overview?'overview':`pixels ${x},${y},${width},${height} at source resolution`,buffer:view.toBuffer('image/jpeg',{quality:0.9})});
      };
      add(0,0,size.width,size.height,true);
      if(Math.max(size.width,size.height)>MAX_EDGE_PX)for(const y of offsets(size.height))for(const x of offsets(size.width))add(x,y,Math.min(MAX_EDGE_PX,size.width),Math.min(MAX_EDGE_PX,size.height));
      const sizeBytes=views.reduce((sum,view)=>sum+view.buffer.length,0);
      if(sizeBytes<=16*1024*1024){
        while(sourceViewCacheBytes+sizeBytes>16*1024*1024&&sourceViewCache.size){const first=sourceViewCache.keys().next().value!;sourceViewCacheBytes-=sourceViewCache.get(first)!.reduce((sum,view)=>sum+view.buffer.length,0);sourceViewCache.delete(first);}
        sourceViewCache.set(cacheKey,views);sourceViewCacheBytes+=sizeBytes;
      }
      return views;
    },
  };
}

export function extractPdfText(pdfBuffer: Buffer): string {
  const raw = pdfBuffer.toString("latin1");
  const tjMatches = [...raw.matchAll(/\(([^)]+)\)\s*Tj/g)].map((m) => m[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\n/g, " "));
  if (tjMatches.length) return tjMatches.join("\n");
  const parens = [...raw.matchAll(/\(([^)]{3,})\)/g)].map((m) => m[1]);
  const filtered = parens.filter((t) => /[A-Za-z]{2,}/.test(t) && !/^D:/.test(t));
  return filtered.join("\n").slice(0, 8000);
}

// PERF OPTIMIZATION: Memoize extracted SVG text across vision & compliance pipeline turns.
// SVG drawing parsing involves regex matchAll across large XML strings and entity decoding.
// Source digests and bounded LRU eviction avoid reusing text from a different drawing.
const SVG_TEXT_CACHE_MAX_SIZE = 50;
const svgTextCache = new Map<string, string>();

/**
 * Generic SVG Vector Text and Label Extractor.
 * Parses <text>, <tspan>, <title>, and <desc> XML nodes from SVG vector drawings,
 * stripping internal tags, decoding XML entities, and preserving drawing identifiers.
 */
export function extractSvgText(svgBuffer: Buffer, maxChars: number | null = 8000): string {
  const key = createHash('sha256').update(svgBuffer).digest('hex');
  const cached = svgTextCache.get(key);
  if (cached !== undefined) {
    // Refresh position for true LRU eviction
    svgTextCache.delete(key);
    svgTextCache.set(key, cached);
    return maxChars === null ? cached : cached.slice(0, maxChars);
  }

  const result = computeExtractSvgText(svgBuffer);

  if (svgTextCache.size >= SVG_TEXT_CACHE_MAX_SIZE) {
    const firstKey = svgTextCache.keys().next().value;
    if (firstKey !== undefined) svgTextCache.delete(firstKey);
  }
  svgTextCache.set(key, result);

  return maxChars === null ? result : result.slice(0, maxChars);
}

function computeExtractSvgText(svgBuffer: Buffer): string {
  const raw = svgBuffer.toString("utf-8");
  const lines: string[] = [];

  const decodeXml = (s: string) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&deg;/g, "°")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\s+/g, " ")
      .trim();

  // Match all <text ...> ... </text> elements (including multiline and nested tspans)
  const textTagMatches = raw.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi);
  for (const match of textTagMatches) {
    const cleanText = decodeXml(match[1]);
    if (cleanText && !lines.includes(cleanText)) {
      lines.push(cleanText);
    }
  }

  // Also check for <title> and <desc> tags if present
  const metadataMatches = raw.matchAll(/<(?:title|desc)\b[^>]*>([\s\S]*?)<\/(?:title|desc)>/gi);
  for (const match of metadataMatches) {
    const cleanText = decodeXml(match[1]);
    if (cleanText && !lines.includes(cleanText)) {
      lines.push(cleanText);
    }
  }

  return lines.join("\n");
}

export interface PdfInspectionResult {
  tier: "text" | "vision";
  pageCount: number;
  extractedText: string;
  charCount: number;
  reason: string;
  estimatedTokensSaved: number;
}

const VISUAL_INTENT_PATTERN =
  /\b(drawing|drawings|diagram|diagrams|p&id|pid|schematic|schematics|blueprint|blueprints|cad|layout|handwritten|handwriting|signature|stamp|stamps|photo|photograph|annotation|annotations|visual)\b/i;

/**
 * Inspects a PDF buffer in <10ms to decide whether it can be efficiently processed
 * as digital text (Tier 1) or requires full visual rendering (Tier 2).
 */
export function analyzePdf(pdfBuffer: Buffer, userPrompt: string): PdfInspectionResult {
  // Count pages via PDF structure
  const rawLatin1 = pdfBuffer.toString("latin1");
  const pageMatches = rawLatin1.match(/\/Type\s*\/Page[^s]/g);
  const pageCount = Math.max(pageMatches ? pageMatches.length : 1, 1);

  // Heuristic token estimation for Tier 2: ~1400 tokens per page
  const estimatedVisionTokens = pageCount * 1400;

  // 1. Check if user prompt explicitly requests visual or drawing analysis
  if (VISUAL_INTENT_PATTERN.test(userPrompt)) {
    return {
      tier: "vision",
      pageCount,
      extractedText: "",
      charCount: 0,
      reason: "visual / drawing keyword detected in user prompt",
      estimatedTokensSaved: 0,
    };
  }

  // 2. Extract digital text
  const extractedText = extractPdfText(pdfBuffer);
  const charCount = extractedText.trim().length;
  const avgCharsPerPage = charCount / pageCount;

  // 3. Threshold check: If average text >= 60 chars per page and total chars >= 150, it's digital text (Tier 1)
  // Otherwise, it is likely a scanned image, drawing, or sparse document (Tier 2 Vision)
  if (charCount >= 150 && avgCharsPerPage >= 60) {
    const textTokens = Math.ceil(charCount / 4);
    const tokensSaved = Math.max(estimatedVisionTokens - textTokens, 0);
    return {
      tier: "text",
      pageCount,
      extractedText,
      charCount,
      reason: `clean digital text detected (${charCount} chars across ${pageCount} page(s))`,
      estimatedTokensSaved: tokensSaved,
    };
  }

  return {
    tier: "vision",
    pageCount,
    extractedText,
    charCount,
    reason: `scanned document or visual drawing (${charCount} chars detected for ${pageCount} page(s))`,
    estimatedTokensSaved: 0,
  };
}

export interface PageVisualScore {
  pageNumber: number;
  score: number;
  imageOps: number;
  vectorOps: number;
  charCount: number;
  isLandscape: boolean;
  hasQueryMatch: boolean;
  pageText: string;
}

export interface PageRankingResult {
  selectedPages: number[];
  unselectedPages: number[];
  unselectedText: string;
  scores: PageVisualScore[];
  totalDocPages: number;
  estimatedTokensSaved: number;
}

/**
 * Deterministic Visual Page Ranker (<20ms).
 * Analyzes vector path density (P&ID/CAD), embedded raster images (XObject images),
 * aspect ratio geometry (landscape blueprints), and query tags to identify the most visually
 * important pages to rasterize, while extracting text from the rest.
 */
export async function rankPagesByVisualDensity(
  pdfBuffer: Buffer,
  userPrompt: string,
  maxPages = 2,
): Promise<PageRankingResult> {
  const promptTokens = (userPrompt.toLowerCase().match(/\b[a-z0-9_\-]{2,}\b/g) ?? []).filter(
    (w) => !["the", "and", "for", "with", "this", "that", "from", "check", "inspect", "show", "what", "where", "please"].includes(w),
  );
  const drawingMarkers = ["p&id", "dwg", "drawing", "schematic", "scale", "diagram", "rev", "title", "layout", "dimension", "component"];

  try {
    const pdfjs = await loadPdfJs();

    if (pdfjs?.getDocument) {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
      const totalDocPages = doc.numPages;
      const scores: PageVisualScore[] = [];

      for (let i = 1; i <= totalDocPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const isLandscape = vp.width > vp.height || vp.width >= 1000;

        let imageOps = 0;
        let vectorOps = 0;
        try {
          const ops = await page.getOperatorList();
          for (let o = 0; o < ops.fnArray.length; o++) {
            const fn = ops.fnArray[o];
            // OPS: 85 = paintImageXObject, 86 = paintInlineImageXObject, 63 = beginInlineImage, 83 = paintImageMaskXObject
            if (fn === 85 || fn === 86 || fn === 63 || fn === 83 || fn === 84 || fn === 88 || fn === 89) {
              imageOps++;
            }
            // OPS: 91 = constructPath, 20 = stroke, 21 = closeStroke, 22 = fill, 23 = eoFill, 24 = fillStroke, 25 = eoFillStroke
            if (fn === 91 || fn === 20 || fn === 21 || fn === 22 || fn === 23 || fn === 24 || fn === 25 || fn === 26 || fn === 27) {
              vectorOps++;
            }
          }
        } catch {}

        let pageText = "";
        try {
          const tc = await page.getTextContent();
          pageText = tc.items.map((it: { str?: string }) => it.str || "").join(" ");
        } catch {}
        const charCount = pageText.trim().length;

        const lowerText = pageText.toLowerCase();
        const hasQueryMatch =
          promptTokens.some((kw) => lowerText.includes(kw)) ||
          drawingMarkers.some((dm) => lowerText.includes(dm));

        // Scoring: Vector paths (CAD/P&ID), Images (photos/scans), Geometry (landscape), Keyword match, Text saturation penalty
        const vectorScore = Math.min(Math.round(vectorOps / 30), 100);
        const imageScore = Math.min(imageOps * 80, 160);
        const geomScore = isLandscape ? 40 : 0;
        const queryScore = hasQueryMatch ? 60 : 0;
        const textPenalty = charCount > 1500 && imageOps === 0 && vectorOps < 50 ? 50 : 0;

        const score = vectorScore + imageScore + geomScore + queryScore - textPenalty;

        scores.push({
          pageNumber: i,
          score,
          imageOps,
          vectorOps,
          charCount,
          isLandscape,
          hasQueryMatch,
          pageText,
        });
      }

      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const effectiveMax = Math.min(maxPages, totalDocPages);
      const selected = sorted.slice(0, effectiveMax).map((s) => s.pageNumber).sort((a, b) => a - b);
      const unselected = scores.filter((s) => !selected.includes(s.pageNumber)).map((s) => s.pageNumber);

      const unselectedText = scores
        .filter((s) => unselected.includes(s.pageNumber) && s.charCount > 0)
        .map((s) => `[Page ${s.pageNumber}]:\n${s.pageText.slice(0, 1500)}`)
        .join("\n\n");

      const savedTokens = Math.max(unselected.length * 1400 - Math.ceil(unselectedText.length / 4), 0);

      return {
        selectedPages: selected.length > 0 ? selected : [1],
        unselectedPages: unselected,
        unselectedText,
        scores,
        totalDocPages,
        estimatedTokensSaved: savedTokens,
      };
    }
  } catch {}

  // Fallback: Structural regex inspection (works offline without pdfjs/canvas)
  const rawLatin1 = pdfBuffer.toString("latin1");
  const chunks = rawLatin1.split(/\/Type\s*\/Page\b/).slice(1);
  const totalDocPages = Math.max(chunks.length, 1);

  const fallbackScores: PageVisualScore[] = [];

  if (chunks.length > 0) {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const pageNum = i + 1;

      // Detect landscape MediaBox: [x0 y0 x1 y1]
      const mediaBoxMatch = chunk.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
      let isLandscape = false;
      if (mediaBoxMatch) {
        const width = Math.abs(parseFloat(mediaBoxMatch[3]) - parseFloat(mediaBoxMatch[1]));
        const height = Math.abs(parseFloat(mediaBoxMatch[4]) - parseFloat(mediaBoxMatch[2]));
        isLandscape = width > height || width >= 1000;
      }

      // Detect text from Tj / TJ operators
      const tjMatches = [...chunk.matchAll(/\(([^)]+)\)\s*Tj/g)].map((m) =>
        m[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\n/g, " ")
      );
      const tjText = tjMatches.join(" ");
      const pageText = tjText.trim();
      const charCount = pageText.length;

      // Count image and vector operators in chunk
      const imageMatches = chunk.match(/\/Subtype\s*\/Image|\/Image\b|\/XObject\b/g);
      const imageOps = imageMatches ? imageMatches.length : 0;

      const vectorMatches = chunk.match(/\b([0-9.]+\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s+re|[0-9.]+\s+[0-9.]+\s+[mlc]|[sSfbB]\b)/g);
      const vectorOps = vectorMatches ? vectorMatches.length : 0;

      const lowerText = pageText.toLowerCase();
      const hasQueryMatch =
        promptTokens.some((kw) => lowerText.includes(kw)) ||
        drawingMarkers.some((dm) => lowerText.includes(dm));

      const vectorScore = Math.min(Math.round(vectorOps / 3), 100);
      const imageScore = Math.min(imageOps * 40, 160);
      const geomScore = isLandscape ? 40 : 0;
      const queryScore = hasQueryMatch ? 60 : 0;
      const textPenalty = charCount > 1500 && imageOps === 0 && vectorOps < 50 ? 50 : 0;

      const score = vectorScore + imageScore + geomScore + queryScore - textPenalty;

      fallbackScores.push({
        pageNumber: pageNum,
        score,
        imageOps,
        vectorOps,
        charCount,
        isLandscape,
        hasQueryMatch,
        pageText,
      });
    }
  } else {
    // If no /Type /Page found, single page fallback
    const pageText = extractPdfText(pdfBuffer);
    fallbackScores.push({
      pageNumber: 1,
      score: 50,
      imageOps: 1,
      vectorOps: 0,
      charCount: pageText.length,
      isLandscape: false,
      hasQueryMatch: true,
      pageText,
    });
  }

  const sorted = [...fallbackScores].sort((a, b) => b.score - a.score);
  const effectiveMax = Math.min(maxPages, totalDocPages);
  const selected = sorted.slice(0, effectiveMax).map((s) => s.pageNumber).sort((a, b) => a - b);
  const unselected = fallbackScores.filter((s) => !selected.includes(s.pageNumber)).map((s) => s.pageNumber);

  const unselectedText = fallbackScores
    .filter((s) => unselected.includes(s.pageNumber) && s.charCount > 0)
    .map((s) => `[Page ${s.pageNumber}]:\n${s.pageText.slice(0, 1500)}`)
    .join("\n\n");

  const savedTokens = Math.max(unselected.length * 1400 - Math.ceil(unselectedText.length / 4), 0);

  return {
    selectedPages: selected.length > 0 ? selected : [1],
    unselectedPages: unselected,
    unselectedText,
    scores: fallbackScores,
    totalDocPages,
    estimatedTokensSaved: savedTokens,
  };
}
