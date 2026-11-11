import type { AgentToolCall, AgentToolDefinition } from "../../shared/contracts.js";
import { z } from "zod";
import { parse } from "@babel/parser";
import { spawnSync } from "node:child_process";
import JSON5 from "json5";
import { getPythonExecutable } from "../tools/python-runtime.js";
import { indexSymbols, parseFileSync, SymbolRange } from "./symbol-index.js";
import { checkBufferSyntax, formatDiagnostics } from "./codeintel/diagnostics.js";
import type { AgentRepairSource } from "./repair-proposal.js";

export function parseJsonWithEscapedCode(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    try {
      const sanitized = str.replace(/\\(.)/g, (match, char) => {
        if (['"', "\\", "/", "b", "f", "n", "r", "t"].includes(char)) return match;
        if (char === "u") return match;
        return "\\\\" + char;
      });
      return JSON.parse(sanitized);
    } catch {
      try {
        return JSON5.parse(str);
      } catch {
        return str;
      }
    }
  }
}

export const REPLACE_SYMBOL_TOOL: AgentToolDefinition = {
  type: "function",
  function: {
    name: "replace_symbol",
    description: "Replace one or more named symbols in the observed target file. Provide only the new source of each symbol.",
    parameters: {
      type: "object",
      required: ["edits"],
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            required: ["symbol", "new_source"],
            properties: {
              symbol: { type: "string" },
              new_source: { type: "string", maxLength: 12000 }
            },
            additionalProperties: false
          }
        },
        context_needed: { type: "string" },
        blocked_reason: { type: "string" }
      },
      additionalProperties: false
    }
  }
};

const symbolEditCallSchema = z.object({
  edits: z.preprocess((val) => {
    if (typeof val === "string") {
      const parsed = parseJsonWithEscapedCode(val);
      return Array.isArray(parsed) ? parsed : val;
    }
    return val;
  }, z.array(z.object({
    symbol: z.string().min(1),
    new_source: z.string().min(1).max(12000)
  }).strict()).min(1).max(3)).optional(),
  context_needed: z.string().min(1).optional(),
  blocked_reason: z.string().min(1).optional(),
  requirement_id: z.string().optional()
}).strict();

function cleanSourceString(src: string): string {
  let s = src.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  return s;
}

function validateJsTsSymbolSource(filePath: string, targetSymbol: SymbolRange, newSource: string): void {
  const isTs = /\.[cm]?tsx?$/i.test(filePath);
  const cleanSource = cleanSourceString(newSource);

  if (targetSymbol.kind === "method") {
    // Wrap in dummy class to parse class method syntax
    const wrapped = `class _Check_ {\n${cleanSource}\n}`;
    let ast: any;
    try {
      ast = parse(wrapped, {
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
    } catch (err: any) {
      throw new Error(`Failed to parse replacement method for "${targetSymbol.name}": ${err.message}`);
    }

    const members = ast.program.body[0]?.body?.body ?? [];
    if (members.length !== 1) {
      throw new Error(`Replacement for method "${targetSymbol.name}" must contain exactly one member, found ${members.length}.`);
    }
    const member = members[0];
    let parsedName = "";
    if (member.key?.type === "Identifier") parsedName = member.key.name;
    else if (member.key?.type === "PrivateName") parsedName = `#${member.key.id.name}`;
    else if (member.key?.type === "StringLiteral") parsedName = member.key.value;
    else if (member.kind === "constructor") parsedName = "constructor";

    const expectedMethodName = targetSymbol.name.split(".").pop();
    if (parsedName !== expectedMethodName) {
      throw new Error(`Replacement method name "${parsedName}" does not match target symbol "${targetSymbol.name}".`);
    }
    return;
  }

  // For functions, classes, and variable_functions
  let ast: any;
  try {
    ast = parse(cleanSource, {
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
  } catch (err: any) {
    throw new Error(`Failed to parse replacement source for "${targetSymbol.name}": ${err.message}`);
  }

  const body = ast.program.body;
  if (body.length !== 1) {
    throw new Error(`Replacement for "${targetSymbol.name}" must contain exactly one top-level declaration, found ${body.length}.`);
  }

  let decl = body[0];
  if (decl.type === "ExportNamedDeclaration" || decl.type === "ExportDefaultDeclaration") {
    decl = decl.declaration ?? decl;
  }

  if (targetSymbol.kind === "function") {
    if (decl.type !== "FunctionDeclaration") {
      throw new Error(`Replacement for function "${targetSymbol.name}" must be a function declaration, got ${decl.type}.`);
    }
    if (targetSymbol.name !== "default" && decl.id?.name !== targetSymbol.name) {
      throw new Error(`Replacement function name "${decl.id?.name}" does not match target symbol "${targetSymbol.name}".`);
    }
  } else if (targetSymbol.kind === "class") {
    if (decl.type !== "ClassDeclaration") {
      throw new Error(`Replacement for class "${targetSymbol.name}" must be a class declaration, got ${decl.type}.`);
    }
    if (targetSymbol.name !== "default" && decl.id?.name !== targetSymbol.name) {
      throw new Error(`Replacement class name "${decl.id?.name}" does not match target symbol "${targetSymbol.name}".`);
    }
  } else if (targetSymbol.kind === "variable_function") {
    if (decl.type !== "VariableDeclaration") {
      throw new Error(`Replacement for variable function "${targetSymbol.name}" must be a variable declaration, got ${decl.type}.`);
    }
    const declarator = decl.declarations[0];
    if (declarator.id?.name !== targetSymbol.name) {
      throw new Error(`Replacement variable name "${declarator.id?.name}" does not match target symbol "${targetSymbol.name}".`);
    }
    if (declarator.init?.type !== "ArrowFunctionExpression" && declarator.init?.type !== "FunctionExpression") {
      throw new Error(`Replacement variable "${targetSymbol.name}" must be initialized with a function or arrow function.`);
    }
  }
}

const PYTHON_VALIDATE_SCRIPT = `
import ast, json, sys
src = sys.stdin.buffer.read().decode("utf-8")
try:
    tree = ast.parse(src)
    body = tree.body
    if len(body) != 1:
        print(json.dumps({"error": f"Expected exactly 1 declaration, got {len(body)}"}))
    else:
        n = body[0]
        kind = type(n).__name__
        name = getattr(n, "name", None)
        print(json.dumps({"kind": kind, "name": name}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

function validateAndRebasePythonSource(targetSymbol: SymbolRange, newSource: string): string {
  let cleanSource = cleanSourceString(newSource);
  let python: string;
  try {
    python = getPythonExecutable();
  } catch {
    return cleanSource;
  }

  const res = spawnSync(python, ["-I", "-c", PYTHON_VALIDATE_SCRIPT], {
    input: Buffer.from(cleanSource, "utf8"),
    timeout: 5000,
    encoding: "utf8"
  });

  if (res.status === 0 && res.stdout?.trim()) {
    try {
      const data = JSON.parse(res.stdout);
      if (data.error) {
        throw new Error(`Python AST validation failed for "${targetSymbol.name}": ${data.error}`);
      }
      const expectedName = targetSymbol.name.split(".").pop();
      if (data.name && data.name !== expectedName) {
        throw new Error(`Replacement Python symbol "${data.name}" does not match target "${targetSymbol.name}".`);
      }
    } catch (e: any) {
      if (e.message.includes("Python AST validation") || e.message.includes("does not match target")) {
        throw e;
      }
    }
  }

  // Rebase indentation to original column
  const col = targetSymbol.col ?? 0;
  if (col > 0) {
    const indent = " ".repeat(col);
    cleanSource = cleanSource
      .split("\n")
      .map(line => (line.trim().length > 0 ? indent + line : line))
      .join("\n");
  }

  return cleanSource;
}

/** Resolves symbols against the CURRENT bytes and lowers to the existing edit_file call. */
export async function bindSymbolEdit(
  call: AgentToolCall,
  source: AgentRepairSource,
  bytes: Buffer
): Promise<{ call: AgentToolCall } | { blocked: string } | { contextNeeded: string }> {
  if (call.name !== "replace_symbol") {
    throw new Error(`Expected replace_symbol call, got ${call.name}`);
  }

  const args = symbolEditCallSchema.parse(call.arguments);
  if (args.blocked_reason && (!args.edits || args.edits.length === 0)) {
    return { blocked: args.blocked_reason };
  }
  if (args.context_needed && (!args.edits || args.edits.length === 0)) {
    return { contextNeeded: args.context_needed };
  }
  if (!args.edits || args.edits.length === 0) {
    if (args.blocked_reason) return { blocked: args.blocked_reason };
    if (args.context_needed) return { contextNeeded: args.context_needed };
    throw new Error("replace_symbol requires at least one edit, context_needed, or blocked_reason.");
  }

  const symbols = await indexSymbols(source.path, bytes);
  const isPython = /\.py$/i.test(source.path);

  const replacements: Array<{ old: string; new: string; startByte: number; endByte: number }> = [];

  for (const edit of args.edits) {
    const normalizedTarget = edit.symbol.replace(/::/g, ".");
    let matched = symbols.find(s => s.name === edit.symbol || s.name === normalizedTarget);
    if (!matched && !normalizedTarget.includes(".")) {
      const suffixMatches = symbols.filter(s => s.name.endsWith(`.${normalizedTarget}`));
      if (suffixMatches.length === 1) {
        matched = suffixMatches[0];
      }
    }

    if (!matched) {
      const available = symbols.map(s => s.name).join(", ");
      throw new Error(`Symbol "${edit.symbol}" not found in ${source.path}. Available symbols: ${available || "none"}`);
    }

    const old = bytes.subarray(matched.startByte, matched.endByte).toString("utf8");
    let finalNewSource: string;
    if (isPython) {
      finalNewSource = validateAndRebasePythonSource(matched, edit.new_source);
    } else if (/\.[cm]?[jt]sx?$/i.test(source.path)) {
      validateJsTsSymbolSource(source.path, matched, edit.new_source);
      finalNewSource = cleanSourceString(edit.new_source);
      if (!/^\s*export\b/.test(old) && /^\s*export\b/.test(finalNewSource)) {
        finalNewSource = finalNewSource.replace(/^\s*export\s+(?:default\s+)?/, "");
      }
    } else {
      finalNewSource = cleanSourceString(edit.new_source);
      const snippetErrors = checkBufferSyntax(source.path, Buffer.from(finalNewSource, "utf8"));
      if (snippetErrors.length > 0) {
        throw new Error(`Syntax error in replacement for "${matched.name}": ${formatDiagnostics(snippetErrors, 3, 400)}`);
      }
      const parsedReplacement = parseFileSync(source.path, Buffer.from(finalNewSource, "utf8"));
      const expectedShort = matched.name.split(".").pop()!;
      if (
        parsedReplacement.symbols.length > 0 &&
        !parsedReplacement.symbols.some(s => s.name === matched!.name || s.name === expectedShort || s.name.endsWith(`.${expectedShort}`))
      ) {
        throw new Error(`Replacement symbol "${parsedReplacement.symbols[0].name}" does not match target "${matched.name}".`);
      }
      const leadingIndent = old.match(/^[ \t]+/)?.[0] ?? "";
      if (leadingIndent && !/^[ \t]/.test(finalNewSource)) {
        finalNewSource = finalNewSource
          .split("\n")
          .map(line => (line.trim().length > 0 ? leadingIndent + line : line))
          .join("\n");
      }
    }

    replacements.push({
      old,
      new: finalNewSource,
      startByte: matched.startByte,
      endByte: matched.endByte
    });
  }

  // Check for overlapping edits
  replacements.sort((a, b) => a.startByte - b.startByte);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].startByte < replacements[i - 1].endByte) {
      throw new Error("Symbol edit ranges overlap.");
    }
  }

  const requirementId = args.requirement_id || (source as any).requirementId;

  return {
    call: {
      id: call.id,
      name: "edit_file",
      arguments: {
        path: source.path,
        expected_digest: source.digest,
        replacements: replacements.map(r => ({ old: r.old, new: r.new })),
        ...(requirementId ? { requirement_id: requirementId } : {})
      }
    }
  };
}
