import { describe, expect, test } from "bun:test";

const scriptPath = new URL("../scripts/bstress-node.sh", import.meta.url);

describe("bstress node helper", () => {
  test("prefers current lastdbd binary names before legacy lastdb_server", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain('$FOLD_ROOT/target/release/lastdbd');
    expect(script).toContain('$FOLD_ROOT/target/debug/lastdbd');
    expect(script.indexOf('$FOLD_ROOT/target/release/lastdbd')).toBeLessThan(
      script.indexOf("$DEFAULT_BIN"),
    );
    expect(script.indexOf("$DEFAULT_BIN")).toBeLessThan(
      script.indexOf('$FOLD_ROOT/target/release/lastdb_server'),
    );
  });

  test("launch passes the node home as data-dir so socket matches state", async () => {
    const script = await Bun.file(scriptPath).text();

    expect(script).toContain('SOCK="$HOME_DIR/data/folddb.sock"');
    expect(script).toContain('nohup "$BIN" --data-dir "$HOME_DIR"');
    expect(script).not.toContain('nohup "$BIN" --data-dir "$HOME_DIR/data"');
  });
});
