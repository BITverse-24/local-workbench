import { parse } from "@babel/parser";
import { spawnSync } from "node:child_process";
import { getPythonExecutable } from "../tools/python-runtime.js";
import { parsePolyglotFile } from "./codeintel/adapters/polyglot.js";

export interface SymbolRange {
  name: string; // "parseRow" | "OrderStore.add"
  kind: "function" | "method" | "class" | "variable_function";
  startByte: number;
  endByte: number; // BYTE offsets in the file (UTF-8)
  startLine: number;
  endLine: number;
  exported: boolean;
  col?: number;
}

export interface ImportBinding {
  from: string;
  names: string[];
  line: number;
}

export interface SymbolReference {
  name: string;
  line: number;
  col: number;
  kind: "call" | "read" | "write" | "type";
}

export interface ParsedFile {
  symbols: SymbolRange[];
  imports: ImportBinding[];
  exports: string[];
  refs: SymbolReference[];
}

type ExtraParseHook = (filePath: string, bytes: Buffer) => ParsedFile | undefined;
const extraParseHooks: ExtraParseHook[] = [];
/** Allows Phase C (tree-sitter adapters) to register additional languages without circular imports. */
export function registerLanguageParser(hook: ExtraParseHook): void {
  extraParseHooks.push(hook);
}

const PYTHON_PARSE_SCRIPT = `
import ast, json, sys
src = sys.stdin.buffer.read().decode("utf-8")
symbols, imports, exports, refs = [], [], [], []
def visit_defs(body, prefix=""):
    for n in body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = min([n.lineno] + [d.lineno for d in n.decorator_list])
            name = prefix + n.name
            symbols.append({"name": name, "kind": type(n).__name__, "startLine": start, "endLine": n.end_lineno, "col": n.col_offset})
            if not prefix and not n.name.startswith("_"):
                exports.append(name)
            if isinstance(n, ast.ClassDef):
                visit_defs(n.body, name + ".")
try:
    tree = ast.parse(src)
    visit_defs(tree.body)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.append({"from": node.names[0].name if node.names else "", "names": [a.asname or a.name.split(".")[-1] for a in node.names], "line": getattr(node, "lineno", 1)})
        elif isinstance(node, ast.ImportFrom):
            imports.append({"from": node.module or ".", "names": [a.asname or a.name for a in node.names], "line": getattr(node, "lineno", 1)})
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                refs.append({"name": node.func.id, "line": getattr(node, "lineno", 1), "col": getattr(node, "col_offset", 0) + 1, "kind": "call"})
            elif isinstance(node.func, ast.Attribute):
                refs.append({"name": node.func.attr, "line": getattr(node, "lineno", 1), "col": getattr(node, "col_offset", 0) + 1, "kind": "call"})
        elif isinstance(node, ast.Name):
            kind = "write" if isinstance(node.ctx, ast.Store) else "read"
            refs.append({"name": node.id, "line": getattr(node, "lineno", 1), "col": getattr(node, "col_offset", 0) + 1, "kind": kind})
    print(json.dumps({"symbols": symbols, "imports": imports, "exports": exports, "refs": refs}))
except Exception:
    print(json.dumps({"symbols": [], "imports": [], "exports": [], "refs": []}))
`;

function buildLineIndex(bytes: Buffer): { lineStarts: number[]; lineEnds: number[] } {
  const lineStarts = [0, 0]; // 1-indexed
  const lineEnds = [0];
  let currentLineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      const end = i > 0 && bytes[i - 1] === 0x0d ? i - 1 : i;
      lineEnds.push(end);
      currentLineStart = i + 1;
      lineStarts.push(currentLineStart);
    }
  }
  lineEnds.push(bytes.length);
  return { lineStarts, lineEnds };
}

function parsePythonFile(bytes: Buffer): ParsedFile {
  const empty: ParsedFile = { symbols: [], imports: [], exports: [], refs: [] };
  let python: string;
  try {
    python = getPythonExecutable();
  } catch {
    return empty;
  }
  try {
    const res = spawnSync(python, ["-I", "-c", PYTHON_PARSE_SCRIPT], {
      input: bytes,
      timeout: 5000,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status !== 0 || !res.stdout?.trim()) return empty;
    const raw = JSON.parse(res.stdout) as {
      symbols: Array<{ name: string; kind: string; startLine: number; endLine: number; col: number }>;
      imports: ImportBinding[];
      exports: string[];
      refs: SymbolReference[];
    };
    const { lineStarts, lineEnds } = buildLineIndex(bytes);
    const symbols: SymbolRange[] = [];
    for (const item of raw.symbols ?? []) {
      if (item.startLine < 1 || item.startLine >= lineStarts.length) continue;
      const endLineIdx = Math.min(item.endLine, lineEnds.length - 1);
      const isMethod = item.name.includes(".");
      symbols.push({
        name: item.name,
        kind: item.kind === "ClassDef" ? "class" : isMethod ? "method" : "function",
        startByte: lineStarts[item.startLine],
        endByte: lineEnds[endLineIdx],
        startLine: item.startLine,
        endLine: item.endLine,
        exported: !item.name.startsWith("_"),
        col: item.col,
      });
    }
    return { symbols, imports: raw.imports ?? [], exports: raw.exports ?? [], refs: raw.refs ?? [] };
  } catch {
    return empty;
  }
}

const JS_STOPWORDS = new Set(["undefined", "null", "true", "false", "NaN", "Infinity", "console", "Math", "Object", "Array", "String", "Number", "Boolean", "Promise", "Error", "JSON", "require", "module", "exports"]);

function parseJsTsFile(filePath: string, bytes: Buffer): ParsedFile {
  const empty: ParsedFile = { symbols: [], imports: [], exports: [], refs: [] };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return empty;
  }
  const isTs = /\.[cm]?tsx?$/i.test(filePath);
  let tree: any;
  try {
    tree = parse(source, {
      sourceType: "unambiguous",
      plugins: [
        "jsx",
        ...(isTs ? (["typescript"] as const) : []),
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "asyncGenerators",
        "dynamicImport",
        "objectRestSpread",
      ],
    });
  } catch {
    return empty;
  }

  const toByte = (charOffset: number): number => Buffer.byteLength(source.slice(0, charOffset), "utf-8");
  const symbols: SymbolRange[] = [];
  const imports: ImportBinding[] = [];
  const exportedNames = new Set<string>();
  const refs: SymbolReference[] = [];

  const indexClassMembers = (classNode: any, className: string, isExported: boolean) => {
    const body = classNode.body?.body ?? [];
    for (const member of body) {
      if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
        let methodName = "";
        if (member.key.type === "Identifier") methodName = member.key.name;
        else if (member.key.type === "PrivateName") methodName = `#${member.key.id.name}`;
        else if (member.key.type === "StringLiteral") methodName = member.key.value;
        else if (member.kind === "constructor") methodName = "constructor";
        if (!methodName) continue;
        let startChar = member.start!;
        if (member.decorators?.length) startChar = Math.min(startChar, ...member.decorators.map((d: any) => d.start!));
        symbols.push({
          name: `${className}.${methodName}`,
          kind: "method",
          startByte: toByte(startChar),
          endByte: toByte(member.end!),
          startLine: member.loc!.start.line,
          endLine: member.loc!.end.line,
          exported: isExported,
        });
      } else if (
        member.type === "ClassProperty" &&
        (member.value?.type === "ArrowFunctionExpression" || member.value?.type === "FunctionExpression") &&
        member.key.type === "Identifier"
      ) {
        let startChar = member.start!;
        if (member.decorators?.length) startChar = Math.min(startChar, ...member.decorators.map((d: any) => d.start!));
        symbols.push({
          name: `${className}.${member.key.name}`,
          kind: "method",
          startByte: toByte(startChar),
          endByte: toByte(member.end!),
          startLine: member.loc!.start.line,
          endLine: member.loc!.end.line,
          exported: isExported,
        });
      }
    }
  };

  for (const node of tree.program.body) {
    if (node.type === "ImportDeclaration" && node.source?.value) {
      const names = (node.specifiers ?? []).map((s: any) => s.local?.name).filter(Boolean);
      imports.push({ from: String(node.source.value), names, line: node.loc?.start?.line ?? 1 });
    } else if (node.type === "ExportNamedDeclaration") {
      for (const spec of node.specifiers ?? []) {
        const exported = spec.exported?.name ?? spec.exported?.value;
        if (exported) exportedNames.add(exported);
      }
      const decl = node.declaration;
      if (!decl) continue;
      if (decl.type === "FunctionDeclaration" && decl.id) {
        exportedNames.add(decl.id.name);
        symbols.push({ name: decl.id.name, kind: "function", startByte: toByte(decl.start!), endByte: toByte(decl.end!), startLine: decl.loc!.start.line, endLine: decl.loc!.end.line, exported: true });
      } else if (decl.type === "ClassDeclaration" && decl.id) {
        const className = decl.id.name;
        exportedNames.add(className);
        symbols.push({ name: className, kind: "class", startByte: toByte(decl.start!), endByte: toByte(decl.end!), startLine: decl.loc!.start.line, endLine: decl.loc!.end.line, exported: true });
        indexClassMembers(decl, className, false);
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (declarator.id.type === "Identifier") exportedNames.add(declarator.id.name);
          if ((declarator.init?.type === "ArrowFunctionExpression" || declarator.init?.type === "FunctionExpression") && declarator.id.type === "Identifier") {
            symbols.push({ name: declarator.id.name, kind: "variable_function", startByte: toByte(decl.start!), endByte: toByte(decl.end!), startLine: decl.loc!.start.line, endLine: decl.loc!.end.line, exported: true });
          }
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (!decl) continue;
      exportedNames.add("default");
      if (decl.type === "FunctionDeclaration") {
        const name = decl.id?.name ?? "default";
        exportedNames.add(name);
        symbols.push({ name, kind: "function", startByte: toByte(decl.start!), endByte: toByte(decl.end!), startLine: decl.loc!.start.line, endLine: decl.loc!.end.line, exported: true });
      } else if (decl.type === "ClassDeclaration") {
        const className = decl.id?.name ?? "default";
        exportedNames.add(className);
        symbols.push({ name: className, kind: "class", startByte: toByte(decl.start!), endByte: toByte(decl.end!), startLine: decl.loc!.start.line, endLine: decl.loc!.end.line, exported: true });
        indexClassMembers(decl, className, false);
      } else if (decl.type === "ArrowFunctionExpression" || decl.type === "FunctionExpression") {
        symbols.push({ name: "default", kind: "variable_function", startByte: toByte(node.start!), endByte: toByte(node.end!), startLine: node.loc!.start.line, endLine: node.loc!.end.line, exported: true });
      }
    } else if (node.type === "FunctionDeclaration" && node.id) {
      symbols.push({ name: node.id.name, kind: "function", startByte: toByte(node.start!), endByte: toByte(node.end!), startLine: node.loc!.start.line, endLine: node.loc!.end.line, exported: false });
    } else if (node.type === "ClassDeclaration" && node.id) {
      const className = node.id.name;
      symbols.push({ name: className, kind: "class", startByte: toByte(node.start!), endByte: toByte(node.end!), startLine: node.loc!.start.line, endLine: node.loc!.end.line, exported: false });
      indexClassMembers(node, className, false);
    } else if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        // CommonJS: const { a, b } = require("./x") or const x = require("./x")
        if (declarator.init?.type === "CallExpression" && declarator.init.callee?.type === "Identifier" && declarator.init.callee.name === "require" && declarator.init.arguments?.[0]?.type === "StringLiteral") {
          const from = String(declarator.init.arguments[0].value);
          const names: string[] = [];
          if (declarator.id.type === "Identifier") names.push(declarator.id.name);
          else if (declarator.id.type === "ObjectPattern") {
            for (const prop of declarator.id.properties ?? []) {
              const local = prop.value?.name ?? prop.key?.name;
              if (local) names.push(local);
            }
          }
          imports.push({ from, names, line: declarator.loc?.start?.line ?? 1 });
        }
        if ((declarator.init?.type === "ArrowFunctionExpression" || declarator.init?.type === "FunctionExpression") && declarator.id.type === "Identifier") {
          symbols.push({ name: declarator.id.name, kind: "variable_function", startByte: toByte(node.start!), endByte: toByte(node.end!), startLine: node.loc!.start.line, endLine: node.loc!.end.line, exported: false });
        }
      }
    }
  }

  // CommonJS exports (`module.exports = { a, b }` or `exports.a = ...`) and identifier references.
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "AssignmentExpression" && n.left?.type === "MemberExpression") {
      const obj = n.left.object;
      const prop = n.left.property;
      if (obj?.type === "Identifier" && obj.name === "module" && prop?.name === "exports" && n.right?.type === "ObjectExpression") {
        for (const p of n.right.properties ?? []) {
          const k = p.key?.name ?? p.key?.value;
          if (k) exportedNames.add(String(k));
        }
      } else if (obj?.type === "Identifier" && obj.name === "exports" && prop?.name) {
        exportedNames.add(String(prop.name));
      }
    } else if (n.type === "CallExpression") {
      const callee = n.callee;
      const id = callee?.type === "Identifier" ? callee : callee?.type === "MemberExpression" && callee.property?.type === "Identifier" ? callee.property : undefined;
      if (id && !JS_STOPWORDS.has(id.name)) {
        refs.push({ name: id.name, line: id.loc?.start?.line ?? 1, col: (id.loc?.start?.column ?? 0) + 1, kind: "call" });
      }
    } else if (n.type === "Identifier" && n.loc && !JS_STOPWORDS.has(n.name)) {
      refs.push({ name: n.name, line: n.loc.start.line, col: n.loc.start.column + 1, kind: "read" });
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
      if (Array.isArray(v)) for (const c of v) walk(c);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(tree.program);

  for (const s of symbols) if (exportedNames.has(s.name)) s.exported = true;
  return { symbols, imports, exports: [...exportedNames], refs };
}

export function parseFileSync(filePath: string, bytes: Buffer): ParsedFile {
  if (/\.py$/i.test(filePath)) return parsePythonFile(bytes);
  if (/\.[cm]?[jt]sx?$/i.test(filePath)) return parseJsTsFile(filePath, bytes);
  const poly = parsePolyglotFile(filePath, bytes);
  if (poly) return poly;
  for (const hook of extraParseHooks) {
    const out = hook(filePath, bytes);
    if (out) return out;
  }
  return { symbols: [], imports: [], exports: [], refs: [] };
}

export function indexSymbolsSync(filePath: string, bytes: Buffer): SymbolRange[] {
  return parseFileSync(filePath, bytes).symbols;
}

export async function indexSymbols(filePath: string, bytes: Buffer): Promise<SymbolRange[]> {
  return indexSymbolsSync(filePath, bytes);
}
