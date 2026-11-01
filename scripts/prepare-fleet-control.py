#!/usr/bin/env python3
"""Give exact main the candidate vocabulary and transport, retaining its old request flow."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

BASE = "e7916cbe4a278fc6c23ecf6be06b884df3f7121b"


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def replace(source, old, new, count=1):
    require(source.count(old) == count, "The exact control source no longer matches the reviewed patch")
    return source.replace(old, new)


def prepare(baseline, candidate, output):
    revision = subprocess.check_output(["git", "-C", str(baseline), "rev-parse", "HEAD"], text=True).strip()
    require(revision == BASE, "The compatibility control requires exact unmodified main")
    require(not subprocess.check_output(["git", "-C", str(baseline), "status", "--porcelain"], text=True),
            "The control checkout contains unrelated edits")
    path = baseline / "src/publish-status.ts"
    source = path.read_text()
    source = 'import { canonicalDefinition, wireFieldNames, wireFields, localFields } from "./status-schema.ts";\n' + source
    source = replace(source, '  let userHash = "";\n', '  let userHash = "";\n  const profiles = new Map<string, SchemaKey>();\n')
    source = replace(source,
        '      const body = await callJson("POST", "/api/apps/declare-schema", { app_id: appId, schema: schemaDef }, userHash);',
        '''      const key = (Object.keys(SCHEMAS) as SchemaKey[]).find((key) => SCHEMAS[key].name === schemaDef.name);
      if (!key) throw new LastDbPublishError("control_schema_unknown", "The control names an unknown record type.");
      const definition = { ...canonicalDefinition(key), alternate_keys: {} };
      const body = await callJson("POST", "/api/apps/declare-schema", { app_id: appId, schema: definition }, userHash);''')
    source = replace(source, '      return { canonical, schemaName };', '      profiles.set(canonical, key);\n      return { canonical, schemaName };')
    # The control still performs the original single-key requests and offset pages.
    source = replace(source, '        fields,\n        filter:', '        fields: wireFieldNames(profiles.get(schemaHash)!, fields),\n        filter:')
    source = replace(source, '          fields,\n          filter:', '          fields: wireFieldNames(profiles.get(schemaHash)!, fields),\n          filter:')
    source = replace(source,
        '      return rows.find((row) => row.key.hash === keyHash && (keyRange === undefined || row.key.range === keyRange))?.fields ?? null;',
        '''      const found = rows.find((row) => row.key.hash === keyHash && (keyRange === undefined || row.key.range === keyRange));
      return found ? localFields(profiles.get(schemaHash)!, found.fields) : null;''')
    source = replace(source,
        '        out.push(...rows.map((row) => ({ keyRange: row.key.range!, fields: row.fields })));',
        '        out.push(...rows.map((row) => ({ keyRange: row.key.range!, fields: localFields(profiles.get(schemaHash)!, row.fields) })));')
    source = replace(source, '        fields_and_values: fields,', '        fields_and_values: wireFields(profiles.get(schemaHash)!, fields),')
    client = (candidate / "src/status-client.ts").read_text()
    transport = client[client.index("function newLastDbJsonCaller("):]
    transport = transport.replace('body?: unknown): Promise<unknown>', 'body?: unknown, _userHash = ""): Promise<unknown>')
    # Both arms use this exact owner-socket transport and deadline. The control
    # retains its auto-identity request; the response error class is local.
    transport = transport.replace(', { status: response.status, body: parsed });', ');')
    start = source.index("function newLastDbJsonCaller(")
    end = source.index("function resolveSocketPath(", start)
    source = source[:start] + transport + "\n" + source[end:]
    path.write_text(source)
    (baseline / "src/status-schema.ts").write_bytes((candidate / "src/status-schema.ts").read_bytes())
    subprocess.run(["git", "-C", str(baseline), "add", "src/publish-status.ts", "src/status-schema.ts"], check=True)
    tree = subprocess.check_output(["git", "-C", str(baseline), "write-tree"], text=True).strip()
    patch = subprocess.check_output(["git", "-C", str(baseline), "diff", "--cached", "--binary"])
    output.mkdir(parents=True, exist_ok=True)
    (output / "control.patch").write_bytes(patch)
    record = {"label": "patched main: canonical vocabulary and owner-socket transport only", "base_revision": BASE,
        "patched_tree": tree, "patch_sha256": hashlib.sha256(patch).hexdigest(),
        "source_sha256": {name: hashlib.sha256((baseline / name).read_bytes()).hexdigest()
            for name in ("src/publish-status.ts", "src/status-schema.ts")},
        "preserved": ["old schema declarations per request", "old primary and copied status layouts",
            "old logical field values and String types", "old serial request sequence", "old digest marker", "old retention policy"],
        "scope": "This control cannot prove conversion from invalid generic field names."}
    (output / "control-source.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.baseline.resolve(), args.candidate.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
