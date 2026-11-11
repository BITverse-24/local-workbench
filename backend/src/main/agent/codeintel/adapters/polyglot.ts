import type { ImportBinding, ParsedFile, SymbolRange, SymbolReference } from "../../symbol-index.js";
import type { Diagnostic } from "../diagnostics.js";

const POLYGLOT_EXT = /\.(?:java|c|cc|cpp|cxx|h|hpp|cs)$/i;

const KEYWORDS = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "default", "break", "continue", "return",
  "try", "catch", "finally", "throw", "throws", "new", "delete", "this", "super", "base",
  "class", "struct", "interface", "enum", "record", "namespace", "package", "import", "using",
  "public", "private", "protected", "internal", "static", "final", "const", "constexpr", "volatile",
  "virtual", "override", "abstract", "sealed", "readonly", "async", "await", "synchronized", "native",
  "inline", "explicit", "friend", "operator", "template", "typename", "typedef", "sizeof", "alignof",
  "void", "bool", "boolean", "byte", "char", "short", "int", "long", "float", "double", "signed", "unsigned",
  "var", "auto", "object", "string", "decimal", "dynamic", "null", "nullptr", "true", "false",
  "extends", "implements", "where", "get", "set", "init", "value", "out", "ref", "in", "params", "lock",
]);

const CONTROL_PARENS = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "synchronized", "lock", "using", "return", "sizeof", "alignof", "delete",
]);

interface BracePair {
  openIndex: number;
  closeIndex: number;
  openLine: number;
  closeLine: number;
  depth: number;
}

interface LexToken {
  type: "ident" | "punct" | "string" | "number";
  value: string;
  index: number;
  line: number;
  col: number;
}

interface LexResult {
  tokens: LexToken[];
  braces: Map<number, BracePair>;
  diagnostics: Diagnostic[];
}

export function isPolyglotPath(filePath: string): boolean {
  return POLYGLOT_EXT.test(filePath);
}

function lexPolyglot(filePath: string, source: string): LexResult {
  const tokens: LexToken[] = [];
  const braces = new Map<number, BracePair>();
  const diagnostics: Diagnostic[] = [];
  const stack: Array<{ ch: "{" | "(" | "["; index: number; line: number; col: number }> = [];

  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const advance = (count = 1) => {
    for (let k = 0; k < count && i < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance();
      continue;
    }

    // Line comment
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < n) {
        if (source[i] === "*" && source[i + 1] === "/") {
          advance(2);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          path: filePath,
          line: startLine,
          col: startCol,
          severity: "error",
          message: "Unclosed block comment '/*'",
          source: "syntax",
        });
      }
      continue;
    }

    // Preprocessor directive (#include, #define, #if, etc.) at start of line
    if (ch === "#") {
      while (i < n && source[i] !== "\n") {
        if (source[i] === "\\" && source[i + 1] === "\n") advance(2);
        else advance();
      }
      continue;
    }

    // Java text block """..."""
    if (ch === '"' && next === '"' && source[i + 2] === '"') {
      const startLine = line;
      const startCol = col;
      advance(3);
      let closed = false;
      while (i < n) {
        if (source[i] === "\\" && i + 1 < n) {
          advance(2);
          continue;
        }
        if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
          advance(3);
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          path: filePath,
          line: startLine,
          col: startCol,
          severity: "error",
          message: "Unclosed text block literal",
          source: "syntax",
        });
      }
      tokens.push({ type: "string", value: '"""', index: i, line: startLine, col: startCol });
      continue;
    }

    // C# verbatim string @"..."
    if (ch === "@" && next === '"') {
      const startLine = line;
      const startCol = col;
      advance(2);
      let closed = false;
      while (i < n) {
        if (source[i] === '"' && source[i + 1] === '"') {
          advance(2);
          continue;
        }
        if (source[i] === '"') {
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          path: filePath,
          line: startLine,
          col: startCol,
          severity: "error",
          message: "Unclosed verbatim string literal",
          source: "syntax",
        });
      }
      tokens.push({ type: "string", value: '@""', index: i, line: startLine, col: startCol });
      continue;
    }

    // Standard string or char literal
    if (ch === '"' || ch === "'") {
      // In C++, digit separators like 1'000'000 use single quote between digits
      if (ch === "'" && i > 0 && /[0-9a-fA-F]/.test(source[i - 1]) && next && /[0-9a-fA-F]/.test(next)) {
        advance();
        continue;
      }
      const quote = ch;
      const startLine = line;
      const startCol = col;
      const startIdx = i;
      advance();
      let closed = false;
      while (i < n) {
        if (source[i] === "\\") {
          advance(2);
          continue;
        }
        if (source[i] === "\n") {
          break;
        }
        if (source[i] === quote) {
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          path: filePath,
          line: startLine,
          col: startCol,
          severity: "error",
          message: `Unclosed ${quote === '"' ? "string" : "character"} literal`,
          source: "syntax",
        });
      }
      tokens.push({ type: "string", value: quote, index: startIdx, line: startLine, col: startCol });
      continue;
    }

    // Identifiers
    if (/[A-Za-z_$]/.test(ch)) {
      const startIdx = i;
      const startLine = line;
      const startCol = col;
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) advance();
      tokens.push({
        type: "ident",
        value: source.slice(startIdx, i),
        index: startIdx,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const startIdx = i;
      const startLine = line;
      const startCol = col;
      while (i < n && /[0-9a-fA-FxXbBoO._']/.test(source[i])) advance();
      tokens.push({
        type: "number",
        value: source.slice(startIdx, i),
        index: startIdx,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    // Delimiters & punctuation
    const startIdx = i;
    const startLine = line;
    const startCol = col;
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ ch, index: startIdx, line: startLine, col: startCol });
      tokens.push({ type: "punct", value: ch, index: startIdx, line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      const expectedOpen = ch === "}" ? "{" : ch === ")" ? "(" : "[";
      const top = stack[stack.length - 1];
      if (!top || top.ch !== expectedOpen) {
        diagnostics.push({
          path: filePath,
          line: startLine,
          col: startCol,
          severity: "error",
          message: top
            ? `Mismatched '${ch}'; expected closing for '${top.ch}' opened at line ${top.line}`
            : `Unexpected closing '${ch}'`,
          source: "syntax",
        });
      } else {
        stack.pop();
        if (ch === "}") {
          const braceDepth = stack.filter((s) => s.ch === "{").length;
          braces.set(top.index, {
            openIndex: top.index,
            closeIndex: startIdx,
            openLine: top.line,
            closeLine: startLine,
            depth: braceDepth,
          });
        }
      }
      tokens.push({ type: "punct", value: ch, index: startIdx, line: startLine, col: startCol });
      advance();
      continue;
    }

    if (ch === ":" && next === ":") {
      tokens.push({ type: "punct", value: "::", index: startIdx, line: startLine, col: startCol });
      advance(2);
      continue;
    }
    if ((ch === "=" || ch === "!" || ch === "<" || ch === ">" || ch === "+" || ch === "-" || ch === "&" || ch === "|") && next === "=") {
      tokens.push({ type: "punct", value: ch + next, index: startIdx, line: startLine, col: startCol });
      advance(2);
      continue;
    }
    if ((ch === "-" && next === ">") || (ch === "=" && next === ">") || (ch === "+" && next === "+") || (ch === "-" && next === "-")) {
      tokens.push({ type: "punct", value: ch + next, index: startIdx, line: startLine, col: startCol });
      advance(2);
      continue;
    }

    tokens.push({ type: "punct", value: ch, index: startIdx, line: startLine, col: startCol });
    advance();
  }

  for (const unclosed of stack) {
    diagnostics.push({
      path: filePath,
      line: unclosed.line,
      col: unclosed.col,
      severity: "error",
      message: `Unclosed '${unclosed.ch}'`,
      source: "syntax",
    });
  }

  // Token-level structural checks (empty assignment/binary operand before ';' or ')')
  const BINARY_ONLY = new Set(["=", "+=", "-=", "*=", "/=", "==", "!=", "<=", ">="]);
  for (let t = 0; t < tokens.length - 1; t++) {
    const cur = tokens[t];
    const nxt = tokens[t + 1];
    if (cur.type === "punct" && BINARY_ONLY.has(cur.value) && nxt.type === "punct" && (nxt.value === ";" || nxt.value === ")" || nxt.value === "}")) {
      diagnostics.push({
        path: filePath,
        line: nxt.line,
        col: nxt.col,
        severity: "error",
        message: `Expected expression after '${cur.value}' before '${nxt.value}'`,
        source: "syntax",
      });
    }
  }

  return { tokens, braces, diagnostics };
}

export function checkPolyglotSyntax(filePath: string, bytes: Buffer): Diagnostic[] {
  if (!isPolyglotPath(filePath)) return [];
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [{ path: filePath, line: 1, col: 1, severity: "error", message: "Invalid UTF-8 byte sequence", source: "syntax" }];
  }
  return lexPolyglot(filePath, source).diagnostics;
}

export function parsePolyglotFile(filePath: string, bytes: Buffer): ParsedFile | undefined {
  if (!isPolyglotPath(filePath)) return undefined;
  const empty: ParsedFile = { symbols: [], imports: [], exports: [], refs: [] };
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return empty;
  }

  const lines = source.split(/\r?\n/);
  const lineStartBytes: number[] = [0, 0];
  const lineEndBytes: number[] = [0];
  let offset = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const lineBytes = Buffer.byteLength(lines[idx], "utf8");
    lineStartBytes[idx + 1] = offset;
    lineEndBytes[idx + 1] = offset + lineBytes;
    const hasCr = source[offset + lines[idx].length] === "\r";
    offset += lineBytes + (hasCr ? 2 : 1);
  }

  const imports: ImportBinding[] = [];
  // Extract #include / import / using from lines
  for (let ln = 0; ln < lines.length; ln++) {
    const text = lines[ln].trim();
    const incMatch = text.match(/^#\s*include\s*[<"]([^>"]+)[>"]/);
    if (incMatch) {
      const spec = incMatch[1];
      const base = spec.split("/").pop()?.replace(/\.[^.]+$/, "") ?? spec;
      imports.push({ from: spec, names: [base], line: ln + 1 });
      continue;
    }
    const javaImp = text.match(/^import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/);
    if (javaImp) {
      const spec = javaImp[1];
      const last = spec.split(".").pop() ?? spec;
      imports.push({ from: spec.replace(/\.\*$/, ""), names: last === "*" ? [] : [last], line: ln + 1 });
      continue;
    }
    const csUsing = text.match(/^using\s+(?:static\s+)?(?:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?([A-Za-z_][A-Za-z0-9_.]*)\s*;/);
    if (csUsing) {
      const alias = csUsing[1];
      const spec = csUsing[2];
      const last = alias || spec.split(".").pop() || spec;
      imports.push({ from: spec, names: [last], line: ln + 1 });
    }
  }

  const { tokens, braces } = lexPolyglot(filePath, source);
  const symbols: SymbolRange[] = [];
  const exportedNames = new Set<string>();
  const declPositions = new Set<string>();

  // Helper to expand startLine upward across contiguous @Annotation / [Attribute] / template<...> lines
  const expandStartLine = (declLine: number): number => {
    let start = declLine;
    while (start > 1) {
      const prev = lines[start - 2].trim();
      if (/^(?:@[A-Za-z_]|\[[A-Za-z_]|template\s*<)/.test(prev)) {
        start--;
      } else {
        break;
      }
    }
    return start;
  };

  // Track active enclosing class/struct/interface/enum/record ranges by char index
  const classRanges: Array<{ name: string; openIndex: number; closeIndex: number; depth: number; exported: boolean }> = [];

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];

    // 1. Class / struct / interface / enum / record declaration
    if (
      tok.type === "ident" &&
      (tok.value === "class" || tok.value === "struct" || tok.value === "interface" || tok.value === "enum" || tok.value === "record")
    ) {
      // Find identifier immediately following (skip C# 'class'/'struct' constraint after 'where T : class')
      const prevTok = tokens[t - 1];
      if (prevTok && prevTok.value === ":") continue;

      const nameTok = tokens[t + 1];
      if (!nameTok || nameTok.type !== "ident" || KEYWORDS.has(nameTok.value)) continue;

      // Scan forward to '{' or ';'
      let k = t + 2;
      while (k < tokens.length && tokens[k].value !== "{" && tokens[k].value !== ";") k++;
      if (k >= tokens.length || tokens[k].value !== "{") continue;

      const brace = braces.get(tokens[k].index);
      if (!brace) continue;

      // Check modifiers before 'class'/'struct' on the same or preceding line
      let isPrivate = false;
      for (let m = t - 1; m >= 0 && tokens[m].line >= tok.line - 1; m--) {
        if (tokens[m].value === ";" || tokens[m].value === "}" || tokens[m].value === "{") break;
        if (tokens[m].value === "private") isPrivate = true;
      }

      const startLine = expandStartLine(tok.line);
      const endLine = brace.closeLine;
      const exported = !isPrivate;
      const className = nameTok.value;

      declPositions.add(`${nameTok.line}:${nameTok.col}`);
      symbols.push({
        name: className,
        kind: "class",
        startByte: lineStartBytes[startLine] ?? 0,
        endByte: lineEndBytes[endLine] ?? bytes.length,
        startLine,
        endLine,
        exported,
      });
      if (exported) exportedNames.add(className);
      classRanges.push({
        name: className,
        openIndex: brace.openIndex,
        closeIndex: brace.closeIndex,
        depth: brace.depth,
        exported,
      });
      continue;
    }

    // 2. Function / method / constructor declaration followed by '(' ... ')' ... '{'
    if (tok.type === "ident" && !CONTROL_PARENS.has(tok.value) && !KEYWORDS.has(tok.value) && tokens[t + 1]?.value === "(") {
      // Ensure this '(' is a parameter list followed by '{' (not a call inside an expression ending in ';')
      const openParen = tokens[t + 1];
      // Find matching ')'
      let pDepth = 0;
      let closeParenIdx = -1;
      for (let k = t + 1; k < tokens.length; k++) {
        if (tokens[k].value === "(") pDepth++;
        else if (tokens[k].value === ")") {
          pDepth--;
          if (pDepth === 0) {
            closeParenIdx = k;
            break;
          }
        }
      }
      if (closeParenIdx === -1) continue;

      // Scan after ')' for '{' (allowing 'const', 'noexcept', 'override', 'final', 'throws ...', ': base(...)', 'where ...')
      let bodyBraceTok: LexToken | undefined;
      for (let k = closeParenIdx + 1; k < tokens.length; k++) {
        const v = tokens[k].value;
        if (v === "{") {
          bodyBraceTok = tokens[k];
          break;
        }
        if (v === ";" || v === "}") break;
      }
      if (!bodyBraceTok) continue;

      const brace = braces.get(bodyBraceTok.index);
      if (!brace) continue;

      // Check that token before method/function name is a type, modifier, '::', or '~' (for destructor), or constructor in enclosing class
      const prev = tokens[t - 1];
      const enclosingClass = [...classRanges].reverse().find((c) => tok.index > c.openIndex && tok.index < c.closeIndex);
      const isQualifiedCpp = prev?.value === "::" && tokens[t - 2]?.type === "ident";
      const isConstructor = enclosingClass && tok.value === enclosingClass.name;
      const isDestructor = prev?.value === "~";
      const hasReturnType =
        prev &&
        (prev.type === "ident" ||
          prev.value === ">" ||
          prev.value === "*" ||
          prev.value === "&" ||
          prev.value === "]" ||
          prev.value === "?");

      if (!isQualifiedCpp && !isConstructor && !isDestructor && !hasReturnType) continue;
      // Avoid treating macro invocations or assignments like `auto x = foo(bar) { ... }` as functions
      let hasEqualsBefore = false;
      for (let m = t - 1; m >= 0 && tokens[m].line === tok.line; m--) {
        if (tokens[m].value === ";" || tokens[m].value === "{" || tokens[m].value === "}") break;
        if (tokens[m].value === "=") {
          hasEqualsBefore = true;
          break;
        }
      }
      if (hasEqualsBefore) continue;

      // Only index declarations at top/namespace level or direct member level of an enclosing class
      if (enclosingClass && brace.depth > enclosingClass.depth + 1) continue;
      if (!enclosingClass && brace.depth > 1) continue;

      let headerStartLine = tok.line;
      let isPrivate = false;
      let isStaticFileLocal = false;
      for (let m = t - 1; m >= 0 && tokens[m].line >= tok.line - 2; m--) {
        const mv = tokens[m].value;
        if (mv === ";" || mv === "{" || mv === "}") break;
        headerStartLine = Math.min(headerStartLine, tokens[m].line);
        if (mv === "private") isPrivate = true;
        if (mv === "static" && !enclosingClass && /\.(?:c|cc|cpp|cxx)$/i.test(filePath)) isStaticFileLocal = true;
      }
      const startLine = expandStartLine(headerStartLine);
      const endLine = brace.closeLine;

      const ownerName = isQualifiedCpp ? tokens[t - 2].value : enclosingClass?.name;
      const baseName = isDestructor ? `~${tok.value}` : tok.value;
      const fullName = ownerName ? `${ownerName}.${baseName}` : baseName;
      const kind: SymbolRange["kind"] = ownerName ? "method" : "function";
      const exported = !isPrivate && !isStaticFileLocal;

      declPositions.add(`${tok.line}:${tok.col}`);
      symbols.push({
        name: fullName,
        kind,
        startByte: lineStartBytes[startLine] ?? 0,
        endByte: lineEndBytes[endLine] ?? bytes.length,
        startLine,
        endLine,
        exported,
      });
      if (exported && !ownerName) exportedNames.add(fullName);
      void openParen;
    }
  }

  // Extract references
  const refs: SymbolReference[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type !== "ident" || KEYWORDS.has(tok.value)) continue;
    if (declPositions.has(`${tok.line}:${tok.col}`)) continue;
    const next = tokens[t + 1];
    const prev = tokens[t - 1];
    const kind: SymbolReference["kind"] =
      next?.value === "(" ? "call" : prev?.value === "new" ? "type" : next?.value === "=" ? "write" : "read";
    refs.push({
      name: tok.value,
      line: tok.line,
      col: tok.col,
      kind,
    });
  }

  return {
    symbols,
    imports,
    exports: [...exportedNames],
    refs,
  };
}
