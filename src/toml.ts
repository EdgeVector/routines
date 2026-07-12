// Minimal TOML reader for routine registry files.
//
// The registry format is deliberately flat (id, prompt_path, harness, model,
// effort, rrule, cwd, status, timeout_min, heartbeat_slug) — a handful of
// scalar key = value pairs. We parse exactly that subset so the app carries no
// runtime npm dependency (the LastGit CI gate clones fresh and does NOT run
// `bun install`, so every runtime import must resolve to a node builtin or a
// local file). Supported value kinds: basic strings ("..."), literal strings
// ('...'), integers, floats, and booleans. Table headers ([x]) and arrays are
// not part of the registry schema and are rejected loudly rather than silently
// mis-parsed.

export type TomlValue = string | number | boolean;

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

export function parseToml(text: string): Record<string, TomlValue> {
  const out: Record<string, TomlValue> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const lineNo = i + 1;
    const trimmed = stripComment(raw).trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("[")) {
      throw new TomlError("table headers are not supported in registry files", lineNo);
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new TomlError(`expected key = value, got ${JSON.stringify(trimmed)}`, lineNo);
    }
    const key = trimmed.slice(0, eq).trim();
    const rhs = trimmed.slice(eq + 1).trim();
    if (key.length === 0) throw new TomlError("empty key", lineNo);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new TomlError(`duplicate key ${JSON.stringify(key)}`, lineNo);
    }
    out[key] = parseValue(rhs, lineNo);
  }
  return out;
}

// Remove a trailing `# comment` that is outside of any quoted string.
function stripComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
    } else if (ch === "'") {
      inLiteral = true;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseValue(rhs: string, lineNo: number): TomlValue {
  if (rhs.length === 0) throw new TomlError("empty value", lineNo);
  const first = rhs[0];
  if (first === '"') return parseBasicString(rhs, lineNo);
  if (first === "'") return parseLiteralString(rhs, lineNo);
  if (rhs === "true") return true;
  if (rhs === "false") return false;
  if (rhs.startsWith("[") || rhs.startsWith("{")) {
    throw new TomlError("arrays/inline tables are not supported in registry files", lineNo);
  }
  // number
  if (/^[+-]?\d[\d_]*$/.test(rhs)) {
    const n = Number(rhs.replace(/_/g, ""));
    if (!Number.isFinite(n)) throw new TomlError(`invalid integer ${JSON.stringify(rhs)}`, lineNo);
    return n;
  }
  if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/.test(rhs)) {
    const n = Number(rhs.replace(/_/g, ""));
    if (!Number.isFinite(n)) throw new TomlError(`invalid float ${JSON.stringify(rhs)}`, lineNo);
    return n;
  }
  throw new TomlError(`unquoted/invalid value ${JSON.stringify(rhs)} (quote strings)`, lineNo);
}

function parseBasicString(rhs: string, lineNo: number): string {
  let out = "";
  let i = 1;
  for (; i < rhs.length; i++) {
    const ch = rhs[i];
    if (ch === "\\") {
      const next = rhs[i + 1];
      i++;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        default:
          throw new TomlError(`unsupported escape \\${next ?? ""}`, lineNo);
      }
      continue;
    }
    if (ch === '"') {
      const rest = rhs.slice(i + 1).trim();
      if (rest.length > 0) throw new TomlError(`trailing characters after string: ${rest}`, lineNo);
      return out;
    }
    out += ch;
  }
  throw new TomlError("unterminated basic string", lineNo);
}

function parseLiteralString(rhs: string, lineNo: number): string {
  const end = rhs.indexOf("'", 1);
  if (end < 0) throw new TomlError("unterminated literal string", lineNo);
  const rest = rhs.slice(end + 1).trim();
  if (rest.length > 0) throw new TomlError(`trailing characters after string: ${rest}`, lineNo);
  return rhs.slice(1, end);
}
