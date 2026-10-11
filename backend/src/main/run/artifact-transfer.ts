import path from "node:path";
import { normalizeContractPath } from "./contract.js";

export interface TransferSource {
  artifactId: string;
  runId: string;
  filename: string;
}

/** Resolve only a copy of existing output. Content changes remain model work. */
export function resolveArtifactTransfer(text: string, sources: TransferSource[]): { sourceId: string; targetPath: string } | undefined {
  // Filenames are data, not action words (for example, a script named test.py).
  const instructions = text.replace(/[\w./-]+\.[a-z0-9]{1,10}\b/gi, "");
  if (!/\b(?:workspace|project|repository|repo)\b/i.test(instructions) ||
      !/\b(?:copy|move|moving|add|put|import|transfer)\b/i.test(instructions) ||
      /\b(?:convert|rewrite|revise|edit|modify|summarize|translate|repair|fix|export|download|delete|remove|run|execute|test|update)\b/i.test(instructions) ||
      /\b(?:also|and\s+then)\b/i.test(instructions)) return;

  const sourceText = text.split(/\b(?:as|into|to)\b/i)[0].toLowerCase();
  const named = sources.filter(source => sourceText.includes(source.filename.toLowerCase()));
  let source: TransferSource | undefined;
  if (named.length) {
    const names = new Set(named.map(item => item.filename));
    if (names.size !== 1) throw new Error("Select one saved artifact to copy into the workspace.");
    source = named[named.length - 1];
    if (named.filter(item => item.runId === source!.runId).length > 1) throw new Error("More than one selected input has this filename. Select one source file before copying.");
  } else if (/\b(?:this|that|the|previous|last)\s+(?:file|artifact|output)\b|\b(?:copy|move|put|import|transfer)\s+it\b/i.test(sourceText)) {
    const latest = sources[sources.length - 1];
    if (!latest) throw new Error("No saved artifact is available in this chat. Select the source file.");
    const batch = sources.filter(item => item.runId === latest.runId);
    if (batch.length !== 1) throw new Error("The previous result has more than one artifact. Specify the source filename.");
    source = latest;
  }
  if (!source) return;
  // A rename must be explicit. Otherwise preserve the saved artifact's name.
  const rename = text.match(/\b(?:as|named)\s+[`"']?([^\s`"',;]+\.[a-z0-9]{1,10})/i)?.[1];
  const folder = text.match(/\b(?:workspace|project|repository|repo)\/([^\s`"',;]+)/i)?.[1];
  return { sourceId: source.artifactId, targetPath: normalizeContractPath(rename ?? (folder ? `${folder}/${path.basename(source.filename)}` : path.basename(source.filename))) };
}
