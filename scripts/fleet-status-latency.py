#!/usr/bin/env python3
"""Hosted-CI comparison of actual Routines commands on one owned-schema engine."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import statistics
import subprocess
import sys
import time


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def installed_schemas(node, bindings, contract, output, phase):
    directory = node.call("/api/schemas?include_full=true&include_counts=true")[0]
    save(output / f"installed-{phase}.json", directory)
    require(directory.get("ready") is True and directory.get("full_included") is True and directory.get("counts_included") is True,
        "The actual installed schema metadata is incomplete")
    owned = {schema["name"]: schema for schema in directory.get("schemas", []) if schema.get("owner_app_id") == "routines"}
    canonical = {key: owned[runtime] for key, runtime in bindings.items() if runtime in owned}
    require(set(canonical) == {key for key, runtime in bindings.items() if runtime}, "The publisher's actual schema bindings are incomplete")
    for key, schema in canonical.items():
        definition = contract[key]["definition"]
        require(schema.get("identity_hash") == contract[key]["identity"] and schema.get("descriptive_name") == definition["descriptive_name"]
            and schema.get("schema_type") == definition["schema_type"]
            and [schema.get("key", {}).get(field) for field in ("hash_field", "range_field")] == [definition["key"].get(field) for field in ("hash_field", "range_field")]
            and set(schema.get("fields", [])) == set(definition["fields"])
            and all(schema.get(field) == definition[field] for field in ("field_types", "field_descriptions", "field_data_classifications")),
            "An actual local definition differs from the published field definition")
        require(schema.get("independent_fields") is True and not schema.get("transform_fields")
            and schema.get("alternate_keys", {}) == definition.get("alternate_keys", {}), "A runtime schema does not own its values or uses different keys")
    require(set(owned) == {schema["name"] for schema in canonical.values()}, "Setup retains an unexpected local schema")
    return {key: schema["record_count"] for key, schema in canonical.items()}


def flush(node):
    reply = node.call("/api/db/flush", {})[0]
    require(reply.get("durable") is True, "The owned node lacks a durable flush")


def cli(args, binary, node, home, verb, *flags, allow_failure=False):
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith(("ROUTINES_", "LASTDB", "FOLD", "SENTRY", "OBS_", "OTEL_"))
        and key not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")}
    absent = node.root / "posture-dependency-absent"
    require(not absent.exists(), "The explicitly absent posture dependency unexpectedly exists")
    trace = node.output / "read-pages.jsonl"
    trace_offset = trace.stat().st_size if trace.exists() else 0
    call_id = f"{verb}-{time.perf_counter_ns()}"
    environment.update(ROUTINES_HOME=str(home), ROUTINES_LASTDB_SOCKET=str(node.socket),
        ROUTINES_STATUS_SCHEMA_CONFIG=str(home / "state/status-schemas.json"),
        ROUTINES_SITUATIONS_CLI=str(absent), LASTDB_SUPPRESS_RECOVERY_PHRASE="1",
        ROUTINES_STATUS_READ_TRACE_FILE=str(trace), ROUTINES_STATUS_READ_TRACE_ID=call_id)
    started = time.perf_counter_ns()
    result = subprocess.run([str(binary), verb, *flags], cwd=home, env=environment,
        capture_output=True, text=True, timeout=180)
    elapsed = (time.perf_counter_ns() - started) / 1e6
    pages = []
    if trace.exists():
        with trace.open() as stream:
            stream.seek(trace_offset)
            pages = [json.loads(line) for line in stream if line.strip()]
        require(all(page["call_id"] == call_id for page in pages), "The actual per-page evidence belongs to another CLI call")
    with (node.output / "commands.jsonl").open("a") as stream:
        stream.write(json.dumps({"verb": verb, "call_id": call_id, "elapsed_ms": elapsed, "exit_code": result.returncode,
            "hash_pages": len(pages), "continued_hash_pages": sum(page["cursor"] is not None or page["offset"] != 0 for page in pages),
            "page_statuses": sorted({page["status"] for page in pages if isinstance(page["status"], int)}),
            "pages_without_status": sum(page["status"] is None for page in pages)}) + "\n")
    if result.returncode:
        (node.output / f"failed-{verb}.stderr").write_text(result.stderr[:65536])
        if verb == "read-status":
            # Repeat only the actual failed read on the same owned live node.
            # Keep its real batch item statuses before normal cleanup; no data changes.
            try:
                configured = json.loads((home / "state/status-schemas.json").read_text())
                limit = max(1, min(128, 5000 // (16 * (1 + 2 * len(args.contract["status"]["definition"]["fields"])))))
                queries = [{"schema_name": configured["schemas"]["status"]["runtime"],
                    "fields": args.contract["status"]["definition"]["fields"], "filter": {"HashKey": f"routines#{bucket:02x}"},
                    "key_name": "by_fleet", "limit": limit} for bucket in range(16)]
                save(node.output / "failed-native-read.json", {"queries": queries, "actual_reply": node.call("/api/queries/batch", {"queries": queries})[0]})
                save(node.output / "failed-read-node-status.json", node.call("/api/status")[0])
            except Exception as error:
                save(node.output / "failed-native-read-diagnostic.json", {"error": str(error)})
    require(result.returncode == 0 or allow_failure, f"Actual Routines {verb} failed; see its retained error")
    return result, elapsed


def call_json(args, binary, node, home, verb, *flags):
    result, elapsed = cli(args, binary, node, home, verb, *flags, "--json")
    return json.loads(result.stdout), elapsed


def cloud_off(node, phase):
    status = node.call("/api/sync/byte-backup-v2", {"action": "status"})[0]
    status = status.get("status", status)
    require(all(status.get(key) is False for key in ("enabled", "automatic_backup_enabled", "running")),
        "Cloud sync is not explicitly off; no app operations continue")
    save(node.output / f"cloud-off-{phase}.json", status)


def registry(home, records):
    directory = home / "registry"
    directory.mkdir(parents=True)
    payload = home / "checksum-input.txt"
    payload.write_text("public routines CI checksum input\n" * 64)
    for index in range(records):
        identifier = f"ci-routine-{index:06d}"
        # These are actual app configuration files. The product parses them,
        # computes status, and executes the real checksum command through its gate.
        values = {"id": identifier, "prompt": "Calculate the checksum of the owned public input file.",
            "harness": "codex", "model": "gpt-6", "pin": True, "rrule": "FREQ=DAILY;BYHOUR=12;BYMINUTE=0;BYSECOND=0",
            "cwd": str(home), "status": "active" if index % 2 == 0 else "paused", "group": "dogfood",
            "gate_command": "sha256sum " + shlex.quote(str(payload)), "timeout_min": 1}
        (directory / f"{identifier}.toml").write_text("\n".join(f"{key} = {json.dumps(value)}" for key, value in values.items()) + "\n")
    return {f"ci-routine-{index:06d}" for index in range(records)}


def run_keys(home):
    runs = home / "runs"
    if not runs.exists():
        return []
    # Two fixed levels: routine IDs and the product's actual run directories.
    return sorted((directory.name, run.name) for directory in runs.iterdir() if directory.is_dir()
        for run in directory.iterdir() if run.is_dir() and (run / "meta.json").is_file())


def publication(value, expected):
    require({row["id"] for row in value["rows"]} == expected and len(value["rows"]) == len(expected),
        "The actual collector returned incomplete or duplicate registry membership")
    snapshot = value["snapshot"]
    require(snapshot["situations_ok"] == "false" and "ENOENT" in snapshot["situations_error"],
        "The actual absent posture dependency did not remain an ENOENT and unknown posture")
    require(value["fleetSummary"]["situations_ok"] == "false" and "ENOENT" in value["fleetSummary"]["situations_error"],
        "The fleet marker hides the actual posture error")


def view(value, expected):
    rows = value["rows"]
    require(len(rows) == len(expected) and {row["id"] for row in rows} == expected, "The complete fleet view membership differs")
    require([row["sk"] for row in rows] == sorted(row["sk"] for row in rows), "The complete fleet range order differs")
    for row in rows:
        require(row["sk"] == f"{row['status']}#{row['group_id']}#{row['id']}", "The alternate range order changed")
        bucket = hashlib.sha256(row["id"].encode()).digest()[0] % 16
        require(row["fleet_bucket"] == f"routines#{bucket:02x}", "The stable fleet bucket changed")
    require(value["summary"]["row_count"] == str(len(expected)), "The summary count differs")
    require(value["summary"]["situations_ok"] == "false" and "ENOENT" in value["summary"]["situations_error"],
        "The reader hides the actual unknown posture")
    return rows


def unwrapped(value):
    return value["value"] if isinstance(value, dict) and set(value) == {"value"} else value


def snapshot(node, bindings, contract, coordinates):
    queries = []
    for key, address, range_value in coordinates:
        queries.append({"schema_name": bindings[key], "fields": contract[key]["definition"]["fields"],
            "filter": {"HashKey": address} if range_value is None else {"HashRangeKey": {"hash": address, "range": range_value}},
            "limit": 2, "response_format": "full"})
    observed = {}
    for start in range(0, len(queries), 64):
        batch = queries[start:start + 64]
        reply = node.call("/api/queries/batch", {"queries": batch})[0]
        require(reply.get("count") == len(batch) and len(reply.get("results", [])) == len(batch), "The known-key snapshot batch is incomplete")
        for offset, item in enumerate(reply["results"]):
            key, address, range_value = coordinates[start + offset]
            response = item.get("response", {})
            require(item.get("status") == 200 and response.get("ok") is True and response.get("unresolved_rows") == 0
                and response.get("has_more") is False and len(response.get("results", [])) <= 1, "A known-key snapshot is unresolved or ambiguous")
            identity = json.dumps([key, address, range_value])
            if not response["results"]:
                observed[identity] = None
                continue
            row = response["results"][0]
            require(row.get("key") == {"hash": address, "range": range_value}, "A known-key snapshot returned different primary coordinates")
            declared, present = set(batch[offset]["fields"]), set(row["fields"])
            definition = contract[key]["definition"]
            required = {field for field in definition["key"].values() if field}
            if key == "status":
                alternate = definition["alternate_keys"]["by_fleet"]
                required |= {alternate["hash_field"], contract[key]["field_map"]["sk"]}
                required |= {part["field"] for part in alternate["range_parts"]}
            if not required <= present or not present <= declared:
                save(node.output / "failed-known-key-snapshot.json", {"coordinate": [key, address, range_value],
                    "query": batch[offset], "actual_result": item,
                    "missing_required_fields": sorted(required - present), "unexpected_fields": sorted(present - declared)})
                raise RuntimeError(f"Actual {key} record lacks required key fields or returns undeclared fields; see failed-known-key-snapshot.json")
            values = {field: unwrapped(value) for field, value in row["fields"].items()}
            require(all(value is None or isinstance(value, str) for value in values.values()) and
                all(isinstance(values[field], str) and values[field] for field in required), "A value type or required key field differs")
            require(values[definition["key"]["hash_field"]] == address and
                (range_value is None or values[definition["key"]["range_field"]] == range_value), "A stored primary field differs from its actual coordinates")
            require(set(row.get("metadata", {})) == present and "author_pub_key" in row, "A full query omits actual per-field or row author metadata")
            if any("has_conflicts" in tip and tip["has_conflicts"] is not False and tip["has_conflicts"] != "unknown"
                for tip in row["metadata"].values()):
                save(node.output / "failed-known-key-conflict.json", {"coordinate": [key, address, range_value], "actual_result": item})
                raise RuntimeError("A present field reports retained conflicts or an invalid conflict signal")
            # Molecules change ownership; conflict flags describe this query.
            # Preserve every actual current-tip attribute and optional key presence.
            metadata = {field: {name: value for name, value in row["metadata"][field].items()
                if name not in ("molecule_uuid", "has_conflicts")} for field in values}
            require(all(isinstance(item.get("atom_uuid"), str) and item["atom_uuid"] for item in metadata.values()),
                "A stored field lacks its current atom identity")
            observed[identity] = {"values_sha256": digest(values), "value_bytes": sum(len(json.dumps(value, ensure_ascii=False).encode()) for value in values.values()),
                "present_fields": sorted(present), "absent_fields": sorted(declared - present),
                "null_fields": sorted(field for field, value in values.items() if value is None),
                "metadata": metadata, "row_author": row["author_pub_key"]}
    return observed


def field_volume(observed, contract):
    volume = {key: {field: {"present": 0, "absent": 0, "null": 0, "writer_set": 0} for field in item["definition"]["fields"]}
        for key, item in contract.items()}
    for coordinate, state in observed.items():
        if state is None:
            continue
        key = json.loads(coordinate)[0]
        for presence in ("present", "absent", "null"):
            for field in state[presence + "_fields"]:
                volume[key][field][presence] += 1
        for field, metadata in state["metadata"].items():
            volume[key][field]["writer_set"] += bool(metadata.get("writer_pubkey"))
    return volume


def native_pages(node, binding, contract, expected_rows):
    fields = contract["status"]["definition"]["fields"]
    names = contract["status"]["field_map"]
    observed = []
    for bucket in range(16):
        key, cursor, previous, seen = f"routines#{bucket:02x}", None, None, set()
        for page in range(10000):
            request = {"schema_name": binding, "fields": fields, "filter": {"HashKey": key},
                "key_name": "by_fleet", "limit": 7, "response_format": "full"}
            if cursor is not None:
                request["cursor"] = cursor
            reply = node.call("/api/query", request)[0]
            require(reply.get("ok") is True and reply.get("unresolved_rows") == 0 and isinstance(reply.get("has_more"), bool),
                "A normal native fleet page is incomplete")
            for row in reply["results"]:
                values = {local: unwrapped(row["fields"][wire]) for local, wire in names.items()}
                require(row["key"] == {"hash": values["id"], "range": None}
                    and row["matched_key"] == {"hash": key, "range": values["sk"]}, "A native result changed its primary or alternate coordinates")
                require(previous is None or previous < values["sk"], "A native page repeated or reversed a range key")
                previous = values["sk"]
                observed.append(values)
            if not reply["has_more"]:
                break
            cursor = reply.get("next_cursor")
            token = json.dumps(cursor, sort_keys=True)
            require(cursor and token not in seen, "An opaque native cursor failed to advance")
            seen.add(token)
        else:
            raise RuntimeError("Native fleet continuation exceeded its finite page bound")
    require(sorted(observed, key=lambda row: row["id"]) == sorted(expected_rows, key=lambda row: row["id"]),
        "Native continuation returned different complete field values")
    return {"logical_records": len(observed), "field_values": sum(len(row) for row in observed), "value_bytes": sum(len(value.encode()) for row in observed for value in row.values())}


def measure(args, binary, node, home, expected):
    samples = {"publish_unchanged": [], "read_complete": [], "publish_changed": []}
    for _ in range(args.samples):
        value, elapsed = call_json(args, binary, node, home, "publish-status")
        publication(value, expected)
        samples["publish_unchanged"].append(elapsed)
        value, elapsed = call_json(args, binary, node, home, "read-status")
        rows = view(value, expected)
        samples["read_complete"].append(elapsed)
    changed = sorted(expected)[0]
    for index in range(args.samples):
        cli(args, binary, node, home, "pause" if index % 2 == 0 else "resume", changed)
        value, elapsed = call_json(args, binary, node, home, "publish-status")
        publication(value, expected)
        samples["publish_changed"].append(elapsed)
        value, _ = call_json(args, binary, node, home, "read-status")
        rows = view(value, expected)
        require(next(row for row in rows if row["id"] == changed)["status"] == ("paused" if index % 2 == 0 else "active"),
            "A primary mutation did not update its fleet address")
    return samples, rows


def register_definitions(args, Node):
    require(args.schema_environment == "dev", "Only DEV permits normal account-free registration; PROD uses the registered publisher")
    node = Node(args.daemon, args.daemon_revision, args.output,
        temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(), environment={"ENVIRONMENT": "dev", "EXEMEM_ENV": "dev",
            "LASTDB_SELF_METRICS_TO_DB": "false", "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    try:
        node.start()
        cloud_off(node, "registration")
        home = node.root / "routines"
        (home / "registry").mkdir(parents=True)
        # The normal setup command declares the three active record types under
        # this one CI node identity. This is admission work, never a latency proof.
        installed, _ = call_json(args, args.candidate_binary, node, home, "init-status")
        require(set(installed["schemas"]) == {"status", "runSummaryV2", "fleetSummary"},
            "Normal setup created a historical or duplicate record type")
        bindings = {key: binding["runtime"] for key, binding in installed["schemas"].items()}
        installed_schemas(node, bindings, args.contract, args.output, "registered")
        cloud_off(node, "registered")
        save(args.output / "registration.json", {"scope": "DEV normal three-definition admission only; no latency proof",
            "environment": "dev", "schema_bindings": bindings, "actual_registry_records": 0,
            "cloud_sync": "off", "identity_rotated_on_failure": False})
    finally:
        node.close()


def arm(args, Node, contract, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir()
    binary = args.candidate_binary if label == "candidate" else args.control_binary
    node = Node(args.daemon, args.daemon_revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
        environment={"ENVIRONMENT": args.schema_environment, "EXEMEM_ENV": args.schema_environment,
            "LASTDB_SELF_METRICS_TO_DB": "false", "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    try:
        node.start()
        cloud_off(node, "start")
        home = node.root / "routines"
        expected = registry(home, args.records)
        installed, _ = call_json(args, binary, node, home, "init-status")
        require(set(installed["schemas"]) == {"status", "runSummaryV2", "fleetSummary"},
            "Setup created a historical or duplicate record type")
        # Run real checksum routines. These completed histories come from the
        # product runner, never handcrafted run metadata or collector responses.
        for identifier in sorted(expected)[:4]:
            cli(args, binary, node, home, "run", identifier, "--quiet")
        published, _ = call_json(args, binary, node, home, "publish-status")
        save(output / "publication.json", published)
        publication(published, expected)
        read, _ = call_json(args, binary, node, home, "read-status")
        rows = view(read, expected)
        bindings = published["schemaHashes"]
        actual_counts = installed_schemas(node, bindings, contract, output, "published")
        histories = run_keys(home)
        coordinates = [("status", identifier, None) for identifier in sorted(expected)]
        coordinates += [("fleetSummary", "routines", None)]
        coordinates += [("runSummaryV2", identifier, stamp) for identifier, stamp in histories]
        require(actual_counts == {key: sum(coordinate[0] == key for coordinate in coordinates) for key in actual_counts},
            "Actual primary membership exceeds or differs from the complete known key set")
        before = snapshot(node, bindings, contract, coordinates)
        require(all(value is not None for value in before.values()), "An actual published record is absent")
        save(output / "before-atoms.json", before)
        save(output / "before-field-volume.json", field_volume(before, contract))
        flush(node)
        cloud_off(node, "before-reopen")
        node.stop()
        node.start()
        cloud_off(node, "reopened")
        reopened = snapshot(node, bindings, contract, coordinates)
        require(reopened == before, "The actual reopen changed values, current atoms, authors, or membership")
        save(output / "reopened-atoms.json", reopened)
        samples, rows = measure(args, binary, node, home, expected)
        changed = sorted(expected)[0]
        volume = native_pages(node, bindings["status"], contract, rows)
        removed = changed
        (home / "registry" / f"{removed}.toml").unlink()
        expected.remove(removed)
        value, _ = call_json(args, binary, node, home, "publish-status")
        publication(value, expected)
        value, _ = call_json(args, binary, node, home, "read-status")
        rows = view(value, expected)
        require(snapshot(node, bindings, contract, [("status", removed, None)])[json.dumps(["status", removed, None])] is None,
            "A normal stale primary deletion left the record visible")
        native_pages(node, bindings["status"], contract, rows)
        removed_runs = [("runSummaryV2", identifier, stamp) for identifier, stamp in histories if identifier == removed]
        require(snapshot(node, bindings, contract, removed_runs) == {key: before[key] for key in
            (json.dumps([kind, identifier, stamp]) for kind, identifier, stamp in removed_runs)},
            "A status deletion changed the separate retained run records")
        changed = sorted(expected)[0]
        # Exercise the unchanged default retention policy through actual runs.
        for _ in range(101):
            cli(args, binary, node, home, "run", changed, "--quiet")
        all_runs = run_keys(home)
        value, _ = call_json(args, binary, node, home, "publish-status", "--runs", "200")
        publication(value, expected)
        selected = [(identifier, stamp) for identifier, stamp in all_runs if identifier == changed]
        require(len(selected) >= 102, "The real run history does not cross the default retention bound")
        retained = snapshot(node, bindings, contract, [("runSummaryV2", identifier, stamp) for identifier, stamp in selected])
        expected_stamps = {stamp for _, stamp in selected[-100:]}
        require(all((value is not None) == (json.loads(key)[2] in expected_stamps) for key, value in retained.items()),
            "The actual run-retention result differs from its 100-record bound")
        cloud_off(node, "final")
        flush(node)
        node.stop()
        node.start()
        cloud_off(node, "final-reopen")
        value, _ = call_json(args, binary, node, home, "read-status")
        view(value, expected)
        require(snapshot(node, bindings, contract, [("runSummaryV2", identifier, stamp) for identifier, stamp in selected]) == retained,
            "Run-retention values or atoms differ after the second actual reopen")
        save(output / "retention-atoms.json", retained)
        save(output / "samples.json", samples)
        result = {"label": label, "pair": pair, "samples": samples, "volume": volume,
            "initial_logical_records": len(before), "posture": "unknown: real ENOENT from explicit absent dependency",
            "cloud_sync": "off at every phase", "current_status_primary_and_alternate_delete": True, "actual_run_retention_and_reopen": True}
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("candidate", "control-binary", "candidate-binary", "daemon", "lastdb-source", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("candidate-revision", "control-revision", "daemon-revision"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--records", type=int, default=256)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--schema-environment", choices=("dev", "prod"), required=True)
    parser.add_argument("--register-definitions-only", action="store_true")
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true", "This operational comparison runs only in hosted CI")
    require(128 <= args.records <= 4096 and 16 <= args.samples <= 100, "The comparison volume or sample count is outside its finite bound")
    args.output.mkdir(parents=True)
    sys.path.insert(0, str(args.lastdb_source / "scripts/benchmarks"))
    from node import Node, file_hash
    source = '''import {SCHEMAS,canonicalDefinition,definitionIdentity,fieldRules} from "./src/status-schema.ts";
console.log(JSON.stringify(Object.fromEntries(Object.keys(SCHEMAS).map(key=>[key,{identity:definitionIdentity(canonicalDefinition(key)),definition:canonicalDefinition(key),field_map:Object.fromEntries(Object.entries(fieldRules(key)).map(([field,[name]])=>[field,name]))}]))));'''
    contract = json.loads(subprocess.check_output(["bun", "--eval", source], cwd=args.candidate, text=True))
    args.contract = contract
    if args.register_definitions_only:
        register_definitions(args, Node)
        return
    summary = {"complete": False, "schema_environment": args.schema_environment, "candidate_revision": args.candidate_revision,
        "control_revision": args.control_revision, "daemon_revision": args.daemon_revision,
        "records": args.records, "samples_per_operation_per_arm": args.samples,
        "scope": "publication/lookup with the real posture dependency absent; base-revision control on the same engine",
        "program_sha256": {key: file_hash(getattr(args, key)) for key in ("control_binary", "candidate_binary", "daemon")}, "arms": []}
    try:
        for pair, order in enumerate((("control", "candidate"), ("candidate", "control"))):
            for label in order:
                summary["arms"].append(arm(args, Node, contract, label, pair))
        rows = []
        for operation in ("publish_unchanged", "read_complete", "publish_changed"):
            before = [arm for arm in summary["arms"] if arm["label"] == "control"]
            after = [arm for arm in summary["arms"] if arm["label"] == "candidate"]
            require(len(before) == len(after) == 2, "The comparison lacks balanced AB/BA pairs")
            for name, fraction in (("p50", 0.5), ("p95", 0.95)):
                old = statistics.median(percentile(arm["samples"][operation], fraction) for arm in before)
                new = statistics.median(percentile(arm["samples"][operation], fraction) for arm in after)
                rows.append({"operation": operation, "percentile": name, "before_ms": old, "after_ms": new, "change_percent": (new / old - 1) * 100})
        summary["rows"], summary["complete"] = rows, True
        lines = ["## Routines publication and lookup latency", "", f"Schema service environment: {args.schema_environment}.", "", summary["scope"], "",
            "Both balanced orders passed actual CLI operations from a fresh owned-schema setup. Cloud sync stayed off.",
            "The control is the base revision. Both arms use the same engine build.",
            "Both arms use the same optional page trace. Latency includes the trace cost and every cursor page.",
            "read-pages.jsonl retains actual page statuses/selectors/cursors; commands.jsonl links each CLI call to its page count and elapsed time.",
            "Current atoms, actual author metadata (including unsigned/unset state), optional field absence/null, values, complete membership, native order, deletion, retention, and reopen checks passed.",
            "CLI writes in this cohort are unsigned. This cohort does not establish signed-author preservation.",
            "This does not prove nominal live posture collection or recipient delivery.", "",
            "| Operation | Percentile | Base ms | Candidate ms | Change |", "|---|---|---:|---:|---:|"]
        lines += [f"| {row['operation']} | {row['percentile']} | {row['before_ms']:.3f} | {row['after_ms']:.3f} | {row['change_percent']:+.1f}% |" for row in rows]
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write("\n".join(lines) + "\n")
    finally:
        save(args.output / "comparison.json", summary)


if __name__ == "__main__":
    main()
