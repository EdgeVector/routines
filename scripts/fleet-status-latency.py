#!/usr/bin/env python3
"""Hosted-CI comparison of actual Routines commands, conversion, and an engine upgrade."""
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


def cli(args, binary, node, home, verb, *flags, allow_failure=False):
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith(("ROUTINES_", "LASTDB", "FOLD", "SENTRY", "OBS_", "OTEL_"))
        and key not in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")}
    absent = node.root / "posture-dependency-absent"
    require(not absent.exists(), "The explicitly absent posture dependency unexpectedly exists")
    environment.update(ROUTINES_HOME=str(home), ROUTINES_LASTDB_SOCKET=str(node.socket),
        ROUTINES_STATUS_SCHEMA_CONFIG=str(home / "state/status-schemas.json"),
        ROUTINES_SITUATIONS_CLI=str(absent), LASTDB_SUPPRESS_RECOVERY_PHRASE="1")
    started = time.perf_counter_ns()
    result = subprocess.run([str(binary), verb, *flags], cwd=home, env=environment,
        capture_output=True, text=True, timeout=180)
    elapsed = (time.perf_counter_ns() - started) / 1e6
    with (node.output / "commands.jsonl").open("a") as stream:
        stream.write(json.dumps({"verb": verb, "elapsed_ms": elapsed, "exit_code": result.returncode}) + "\n")
    if result.returncode:
        (node.output / f"failed-{verb}.stderr").write_text(result.stderr[:65536])
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
            require(set(row["fields"]) == set(batch[offset]["fields"]), "A known-key record lacks complete declared fields")
            values = {field: unwrapped(value) for field, value in row["fields"].items()}
            require(all(isinstance(value, str) for value in values.values()), "A String field changed its value type")
            metadata = {field: {name: row.get("metadata", {}).get(field, {}).get(name)
                for name in ("atom_uuid", "writer_pubkey", "metadata")} for field in values}
            require(all(isinstance(item["atom_uuid"], str) and item["atom_uuid"] for item in metadata.values()),
                "A stored field lacks its current atom identity")
            observed[identity] = {"values_sha256": digest(values), "value_bytes": sum(len(value.encode()) for value in values.values()), "metadata": metadata}
    return observed


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


def arm(args, Node, finish_setup, contract, label, pair):
    output = args.output / f"pair-{pair}-{label}"
    output.mkdir()
    fresh = label == "fresh"
    binary = args.candidate_binary if label != "control" else args.control_binary
    daemon, revision = (args.daemon_after, args.daemon_after_revision) if fresh else (args.daemon_before, args.daemon_before_revision)
    node = Node(daemon, revision, output, temporary_directory=Path(os.environ["RUNNER_TEMP"]).resolve(),
        environment={"LASTDB_SELF_METRICS_TO_DB": "false", "LASTDB_BYTE_BACKUP_V2_ENABLED": "false", "LASTDB_TTL_SWEEP": "0"})
    try:
        node.start()
        cloud_off(node, "start")
        home = node.root / "routines"
        expected = registry(home, args.records)
        setup = args.candidate_binary if fresh else args.control_binary
        if fresh:
            call_json(args, setup, node, home, "init-status")
        # Run real checksum routines. These completed histories come from the
        # product runner, never handcrafted run metadata or collector responses.
        for identifier in sorted(expected)[:4]:
            cli(args, setup, node, home, "run", identifier, "--quiet")
        published, _ = call_json(args, setup, node, home, "publish-status")
        publication(published, expected)
        read, _ = call_json(args, setup, node, home, "read-status")
        rows = view(read, expected)
        bindings = published["schemaHashes"]
        histories = run_keys(home)
        coordinates = [("status", identifier, None) for identifier in sorted(expected)]
        coordinates += [("fleetSummary", "routines", None)]
        coordinates += [("runSummaryV2", identifier, stamp) for identifier, stamp in histories]
        copied = [] if fresh else [("fleetStatus", row["fleet_bucket"], row["sk"]) for row in rows]
        before = snapshot(node, bindings, contract, coordinates + copied)
        require(all(value is not None for value in before.values()), "An actual published record is absent before conversion")
        save(output / "before-atoms.json", before)
        if label == "candidate":
            planned, _ = cli(args, binary, node, home, "convert-status-schemas")
            plan = json.loads(planned.stdout)
            require(plan.get("phase") == "plan" and len(plan.get("schemas", [])) == 6 and plan.get("retire") == [], "The explicit app conversion plan differs")
            # The conversion command emits JSON without a --json flag.
            result, _ = cli(args, binary, node, home, "convert-status-schemas", "--apply", "--maintenance")
            report = json.loads(result.stdout)
            require(report.get("phase") == "complete" and report.get("durable") is True
                and report.get("selected_keys") == report.get("expected_selected_keys") == len(coordinates + copied)
                and report.get("retired_schemas") == [], "The actual conversion lacks complete membership or retains a retirement")
            save(output / "conversion.json", report)
            after = snapshot(node, bindings, contract, coordinates + copied)
            require(after == before, "Conversion changed values, current atoms, authors, metadata, or membership")
        finish_setup(node, output)
        cloud_off(node, "before-reopen")
        node.stop()
        node.start()
        cloud_off(node, "reopened")
        reopened = snapshot(node, bindings, contract, coordinates + copied)
        require(reopened == before, "The actual reopen changed values, current atoms, authors, or membership")
        save(output / "reopened-atoms.json", reopened)
        # A converted primary starts with the control's digest marker. Normal
        # publication refreshes it once before any timed native reader request.
        published, _ = call_json(args, binary, node, home, "publish-status")
        publication(published, expected)
        same_engine_samples = None
        if label == "candidate":
            same_engine_samples, _ = measure(args, binary, node, home, expected)
            current = snapshot(node, bindings, contract, coordinates + copied)
            finish_setup(node, output)
            node.stop()
            node.binary, node.revision = args.daemon_after, args.daemon_after_revision
            node.start()
            cloud_off(node, "removal-reopen")
            require(snapshot(node, bindings, contract, coordinates + copied) == current,
                "The removal-engine reopen changed current atoms, authors, values, or membership")
            save(output / "upgrade-atoms.json", current)
        samples, rows = measure(args, binary, node, home, expected)
        changed = sorted(expected)[0]
        volume = native_pages(node, bindings["status"], contract, rows) if label != "control" else {"logical_records": len(rows)}
        if label == "candidate":
            require(snapshot(node, bindings, contract, copied) == {key: value for key, value in before.items() if json.loads(key)[0] == "fleetStatus"},
                "A current primary mutation changed separately retained historical payloads")
        removed = sorted(expected)[-1]
        (home / "registry" / f"{removed}.toml").unlink()
        expected.remove(removed)
        value, _ = call_json(args, binary, node, home, "publish-status")
        publication(value, expected)
        value, _ = call_json(args, binary, node, home, "read-status")
        rows = view(value, expected)
        require(snapshot(node, bindings, contract, [("status", removed, None)])[json.dumps(["status", removed, None])] is None,
            "A normal stale primary deletion left the record visible")
        if label != "control":
            native_pages(node, bindings["status"], contract, rows)
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
        finish_setup(node, output)
        node.stop()
        node.start()
        cloud_off(node, "final-reopen")
        value, _ = call_json(args, binary, node, home, "read-status")
        view(value, expected)
        require(snapshot(node, bindings, contract, [("runSummaryV2", identifier, stamp) for identifier, stamp in selected]) == retained,
            "Run-retention values or atoms differ after the second actual reopen")
        save(output / "retention-atoms.json", retained)
        save(output / "samples.json", samples)
        result = {"label": label, "pair": pair, "samples": samples, "same_engine_samples": same_engine_samples, "volume": volume,
            "initial_logical_records": len(before), "posture": "unknown: real ENOENT from explicit absent dependency",
            "cloud_sync": "off at every phase", "conversion_atom_author_values_preserved": label == "candidate",
            "current_status_primary_and_alternate_delete": True, "actual_run_retention_and_reopen": True}
        save(output / "result.json", result)
        return result
    finally:
        node.close()


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("candidate", "control-binary", "candidate-binary", "daemon-before", "daemon-after", "lastdb-source", "output", "control-source"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("candidate-revision", "daemon-before-revision", "daemon-after-revision"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--records", type=int, default=256)
    parser.add_argument("--samples", type=int, default=20)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true", "This operational comparison runs only in hosted CI")
    require(128 <= args.records <= 4096 and 16 <= args.samples <= 100, "The comparison volume or sample count is outside its finite bound")
    args.output.mkdir(parents=True)
    sys.path.insert(0, str(args.lastdb_source / "scripts/benchmarks"))
    from node import Node, file_hash
    from app_multi_key_compare import finish_setup
    source = '''import {SCHEMAS,canonicalDefinition,fieldRules} from "./src/status-schema.ts";
console.log(JSON.stringify(Object.fromEntries(Object.keys(SCHEMAS).map(key=>[key,{definition:canonicalDefinition(key),field_map:Object.fromEntries(Object.entries(fieldRules(key)).map(([field,[name]])=>[field,name]))}]))));'''
    contract = json.loads(subprocess.check_output(["bun", "--eval", source], cwd=args.candidate, text=True))
    summary = {"complete": False, "candidate_revision": args.candidate_revision,
        "daemon_before_revision": args.daemon_before_revision, "daemon_after_revision": args.daemon_after_revision,
        "control": json.loads(args.control_source.read_text()), "records": args.records, "samples_per_operation_per_arm": args.samples,
        "scope": "publication/lookup with the real posture dependency absent; patched-main control; no generic-field migration proof",
        "program_sha256": {key: file_hash(getattr(args, key)) for key in ("control_binary", "candidate_binary", "daemon_before", "daemon_after")}, "arms": []}
    try:
        for pair, order in enumerate((("control", "candidate"), ("candidate", "control"), ("fresh",))):
            for label in order:
                summary["arms"].append(arm(args, Node, finish_setup, contract, label, pair))
        rows = []
        for comparison, selected in (("same compatible engine", "same_engine_samples"), ("full engine upgrade", "samples")):
            for operation in ("publish_unchanged", "read_complete", "publish_changed"):
                before = [arm for arm in summary["arms"] if arm["label"] == "control"]
                after = [arm for arm in summary["arms"] if arm["label"] == "candidate"]
                require(len(before) == len(after) == 2, "The comparison lacks balanced AB/BA pairs")
                for name, fraction in (("p50", 0.5), ("p95", 0.95)):
                    old = statistics.median(percentile(arm["samples"][operation], fraction) for arm in before)
                    new = statistics.median(percentile(arm[selected][operation], fraction) for arm in after)
                    rows.append({"comparison": comparison, "operation": operation, "percentile": name, "before_ms": old, "after_ms": new, "change_percent": (new / old - 1) * 100})
        summary["rows"], summary["complete"] = rows, True
        lines = ["## Routines publication and lookup latency", "", summary["scope"], "",
            "Both balanced orders and a fresh owned-schema arm passed actual CLI operations. Cloud sync stayed off.",
            "The compatible engine seeded both arms. The candidate converted all six record types before the removal-engine reopen.",
            "The control retains main's serial flow and copied status records after the explicit vocabulary/transport patch.",
            "Current atoms, authors, metadata, values, complete membership, native order, deletion, run retention, and reopen checks passed.",
            "This does not prove nominal live posture collection, invalid generic-name conversion, or recipient delivery.", "",
            "| Comparison | Operation | Percentile | Patched main ms | Candidate ms | Change |", "|---|---|---|---:|---:|---:|"]
        lines += [f"| {row['comparison']} | {row['operation']} | {row['percentile']} | {row['before_ms']:.3f} | {row['after_ms']:.3f} | {row['change_percent']:+.1f}% |" for row in rows]
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write("\n".join(lines) + "\n")
    finally:
        save(args.output / "comparison.json", summary)


if __name__ == "__main__":
    main()
