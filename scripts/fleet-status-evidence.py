#!/usr/bin/env python3
"""Check finite generated CI output before the workflow retains it."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root = args.output.resolve()
    if args.output.is_symlink() or not root.is_dir():
        raise RuntimeError("The retained output root is absent or unsafe")
    files = []
    # Three fixed levels: source files, measurement summary, and arm files.
    for first in root.iterdir():
        if first.is_symlink() or not first.is_dir() or first.name not in ("source", "measurements"):
            raise RuntimeError("An unexpected retained root entry exists")
        for second in first.iterdir():
            if second.is_symlink():
                raise RuntimeError("A retained path is a symlink")
            if second.is_file():
                files.append(second)
            elif first.name == "measurements" and second.is_dir() and second.name.startswith("pair-"):
                for third in second.iterdir():
                    if third.is_symlink() or not third.is_file():
                        raise RuntimeError("A retained arm exceeds its fixed depth")
                    files.append(third)
            else:
                raise RuntimeError("An unexpected retained directory exists")
    if not files or len(files) > 200:
        raise RuntimeError("The retained file count is absent or exceeds its finite bound")
    forbidden = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|\bgh[pousr]_[A-Za-z0-9]{24,}")
    manifest = []
    for path in files:
        if path.stat().st_size > 32 * 1024 * 1024:
            raise RuntimeError("A retained file exceeds its finite review bound")
        raw = path.read_bytes()
        if forbidden.search(raw):
            raise RuntimeError("A credential marker appears in retained output; no upload is authorized")
        if path.suffix == ".json":
            json.loads(raw)
        manifest.append({"path": str(path.relative_to(root)), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    # This is generated runner output, never a source-repo report.
    (root / "source/files.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
    print(f"Checked {len(files)} finite CI files. No private-key or GitHub credential marker appears.")


if __name__ == "__main__":
    main()
