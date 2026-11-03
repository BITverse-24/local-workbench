import { parse } from "@babel/parser";
import { spawnSync } from "node:child_process";
import { getPythonExecutable } from "../tools/python-runtime.js";

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

const PYTHON_SYMBOL_SCRIPT = `
import ast, json, sys
src = sys.stdin.buffer.read().decode("utf-8")
out = []
def visit(body, prefix=""):
    for n in body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = min([n.lineno] + [d.lineno for d in n.decorator_list])
            name = prefix + n.name
            out.append({"name": name, "kind": type(n).__name__,
                        "startLine": start, "endLine": n.end_lineno, "col": n.col_offset})
            if isinstance(n, ast.ClassDef): visit(n.body, name + ".")
try:
    visit(ast.parse(src).body)
    print(json.dumps(out))
except Exception:
    print(json.dumps([]))
`;

function buildLineIndex(bytes: Buffer): { lineStarts: number[]; lineEnds: number[] } {
  const lineStarts = [0, 0]; // 1-indexed
  const lineEnds = [0];

  let currentLineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      // \n found
      const end = i > 0 && bytes[i - 1] === 0x0d ? i - 1 : i;
      lineEnds.push(end);
      currentLineStart = i + 1;
      lineStarts.push(currentLineStart);
    }
  }
  // Last line
  lineEnds.push(bytes.length);
  return { lineStarts, lineEnds };
}

function indexPythonSymbols(bytes: Buffer): SymbolRange[] {
  let python: string;
  try {
    python = getPythonExecutable();
  } catch {
    return [];
  }

  try {
    const res = spawnSync(python, ["-I", "-c", PYTHON_SYMBOL_SCRIPT], {
      input: bytes,
      timeout: 5000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024
    });

    if (res.status !== 0 || !res.stdout?.trim()) return [];
    const items: Array<{ name: string; kind: string; startLine: number; endLine: number; col: number }> = JSON.parse(res.stdout);
    if (!Array.isArray(items)) return [];

    const { lineStarts, lineEnds } = buildLineIndex(bytes);
    const symbols: SymbolRange[] = [];

    for (const item of items) {
      if (item.startLine < 1 || item.startLine >= lineStarts.length) continue;
      const endLineIdx = Math.min(item.endLine, lineEnds.length - 1);
      const startByte = lineStarts[item.startLine];
      const endByte = lineEnds[endLineIdx];

      const isMethod = item.name.includes(".");
      const kind: SymbolRange["kind"] = item.kind === "ClassDef"
        ? "class"
        : isMethod
        ? "method"
        : "function";

      symbols.push({
        name: item.name,
        kind,
        startByte,
        endByte,
        startLine: item.startLine,
        endLine: item.endLine,
        exported: !item.name.startsWith("_"),
        col: item.col
      });
    }

    return symbols;
  } catch {
    return [];
  }
}

function indexJsTsSymbols(filePath: string, bytes: Buffer): SymbolRange[] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
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
        "objectRestSpread"
      ]
    });
  } catch {
    return [];
  }

  const toByte = (charOffset: number): number => {
    return Buffer.byteLength(source.slice(0, charOffset), "utf-8");
  };

  const symbols: SymbolRange[] = [];

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
        if (member.decorators?.length) {
          startChar = Math.min(startChar, ...member.decorators.map((d: any) => d.start!));
        }

        symbols.push({
          name: `${className}.${methodName}`,
          kind: "method",
          startByte: toByte(startChar),
          endByte: toByte(member.end!),
          startLine: member.loc!.start.line,
          endLine: member.loc!.end.line,
          exported: isExported
        });
      } else if (
        member.type === "ClassProperty" &&
        (member.value?.type === "ArrowFunctionExpression" || member.value?.type === "FunctionExpression") &&
        member.key.type === "Identifier"
      ) {
        let startChar = member.start!;
        if (member.decorators?.length) {
          startChar = Math.min(startChar, ...member.decorators.map((d: any) => d.start!));
        }

        symbols.push({
          name: `${className}.${member.key.name}`,
          kind: "method",
          startByte: toByte(startChar),
          endByte: toByte(member.end!),
          startLine: member.loc!.start.line,
          endLine: member.loc!.end.line,
          exported: isExported
        });
      }
    }
  };

  for (const node of tree.program.body) {
    if (node.type === "ExportNamedDeclaration") {
      const decl = node.declaration;
      if (!decl) continue;

      if (decl.type === "FunctionDeclaration" && decl.id) {
        symbols.push({
          name: decl.id.name,
          kind: "function",
          startByte: toByte(decl.start!),
          endByte: toByte(decl.end!),
          startLine: decl.loc!.start.line,
          endLine: decl.loc!.end.line,
          exported: true
        });
      } else if (decl.type === "ClassDeclaration" && decl.id) {
        const className = decl.id.name;
        symbols.push({
          name: className,
          kind: "class",
          startByte: toByte(decl.start!),
          endByte: toByte(decl.end!),
          startLine: decl.loc!.start.line,
          endLine: decl.loc!.end.line,
          exported: true
        });
        indexClassMembers(decl, className, false);
      } else if (decl.type === "VariableDeclaration") {
        for (const declarator of decl.declarations) {
          if (
            (declarator.init?.type === "ArrowFunctionExpression" || declarator.init?.type === "FunctionExpression") &&
            declarator.id.type === "Identifier"
          ) {
            symbols.push({
              name: declarator.id.name,
              kind: "variable_function",
              startByte: toByte(decl.start!),
              endByte: toByte(decl.end!),
              startLine: decl.loc!.start.line,
              endLine: decl.loc!.end.line,
              exported: true
            });
          }
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      if (!decl) continue;

      if (decl.type === "FunctionDeclaration") {
        const name = decl.id?.name ?? "default";
        symbols.push({
          name,
          kind: "function",
          startByte: toByte(decl.start!),
          endByte: toByte(decl.end!),
          startLine: decl.loc!.start.line,
          endLine: decl.loc!.end.line,
          exported: true
        });
      } else if (decl.type === "ClassDeclaration") {
        const className = decl.id?.name ?? "default";
        symbols.push({
          name: className,
          kind: "class",
          startByte: toByte(decl.start!),
          endByte: toByte(decl.end!),
          startLine: decl.loc!.start.line,
          endLine: decl.loc!.end.line,
          exported: true
        });
        indexClassMembers(decl, className, false);
      } else if (decl.type === "ArrowFunctionExpression" || decl.type === "FunctionExpression") {
        symbols.push({
          name: "default",
          kind: "variable_function",
          startByte: toByte(node.start!),
          endByte: toByte(node.end!),
          startLine: node.loc!.start.line,
          endLine: node.loc!.end.line,
          exported: true
        });
      }
    } else if (node.type === "FunctionDeclaration" && node.id) {
      symbols.push({
        name: node.id.name,
        kind: "function",
        startByte: toByte(node.start!),
        endByte: toByte(node.end!),
        startLine: node.loc!.start.line,
        endLine: node.loc!.end.line,
        exported: false
      });
    } else if (node.type === "ClassDeclaration" && node.id) {
      const className = node.id.name;
      symbols.push({
        name: className,
        kind: "class",
        startByte: toByte(node.start!),
        endByte: toByte(node.end!),
        startLine: node.loc!.start.line,
        endLine: node.loc!.end.line,
        exported: false
      });
      indexClassMembers(node, className, false);
    } else if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        if (
          (declarator.init?.type === "ArrowFunctionExpression" || declarator.init?.type === "FunctionExpression") &&
          declarator.id.type === "Identifier"
        ) {
          symbols.push({
            name: declarator.id.name,
            kind: "variable_function",
            startByte: toByte(node.start!),
            endByte: toByte(node.end!),
            startLine: node.loc!.start.line,
            endLine: node.loc!.end.line,
            exported: false
          });
        }
      }
    }
  }

  return symbols;
}

export function indexSymbolsSync(filePath: string, bytes: Buffer): SymbolRange[] {
  if (/\.py$/i.test(filePath)) {
    return indexPythonSymbols(bytes);
  }
  if (/\.[cm]?[jt]sx?$/i.test(filePath)) {
    return indexJsTsSymbols(filePath, bytes);
  }
  return [];
}

export async function indexSymbols(filePath: string, bytes: Buffer): Promise<SymbolRange[]> {
  return indexSymbolsSync(filePath, bytes);
}
