// In-place editor for registry TOML files. pause/resume/route change a single
// scalar key; we rewrite the raw text so comments and unrelated lines survive.

import { readFileSync, writeFileSync } from "node:fs";

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Set string keys in a registry file, preserving all other content. A key that
 * already exists is replaced on its line; a new key is appended. */
export function setKeys(sourcePath: string, updates: Record<string, string>): void {
  const text = readFileSync(sourcePath, "utf8");
  const lines = text.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    const eq = trimmed.indexOf("=");
    if (eq < 0 || trimmed.startsWith("#")) continue;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      const indent = line.slice(0, line.length - trimmed.length);
      lines[i] = `${indent}${key} = ${quote(remaining.get(key)!)}`;
      remaining.delete(key);
    }
  }

  const appended: string[] = [];
  for (const [key, value] of remaining) {
    appended.push(`${key} = ${quote(value)}`);
  }

  let out = lines.join("\n");
  if (appended.length > 0) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += appended.join("\n") + "\n";
  }
  writeFileSync(sourcePath, out);
}
