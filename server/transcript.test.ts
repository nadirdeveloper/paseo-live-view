import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createNormalizer } from "./transcript";

const lines = readFileSync(join(__dirname, "fixtures", "subagent.jsonl"), "utf8").trim().split("\n");

describe("createNormalizer", () => {
  test("turns a transcript into ordered entries and skips non-message lines", () => {
    const entries = createNormalizer().push(lines);
    const summary = entries.map((e) => (e.kind === "tool" ? `tool:${e.name}${e.result !== undefined ? "+result" : ""}` : e.kind));
    expect(summary).toEqual([
      "thinking",
      "text",
      "tool:Read",
      "tool:Read+result",
      "tool:Edit",
      "tool:Edit+result",
      "tool:Write",
      "tool:Write+result",
      "tool:Bash",
      "tool:Bash+result",
      "tool:Bash",
      "tool:Bash+result",
      "tool:Agent",
    ]);
  });

  test("keeps inputs, joins array results, and flags errors", () => {
    const entries = createNormalizer().push(lines);
    const edit = entries.find((e) => e.kind === "tool" && e.name === "Edit" && e.result !== undefined);
    expect(edit).toMatchObject({ callId: "toolu_edit", input: { file_path: "/w/script.js", old_string: "// MyApp", new_string: "// MyApp game" } });
    const bash = entries.find((e) => e.kind === "tool" && e.callId === "toolu_bash" && e.result !== undefined);
    expect(bash).toMatchObject({ result: "# tests 7\n# pass 7", isError: false });
    const failed = entries.find((e) => e.kind === "tool" && e.callId === "toolu_fail" && e.result !== undefined);
    expect(failed).toMatchObject({ isError: true });
    const thinking = entries[0];
    expect(thinking).toMatchObject({ kind: "thinking", id: "msg_1:0", text: "I should look at script.js first." });
  });

  test("feeding the same lines again emits nothing new", () => {
    const n = createNormalizer();
    n.push(lines);
    expect(n.push(lines)).toEqual([]);
  });

  test("a result that arrives in a later push re-emits its call with the result", () => {
    const n = createNormalizer();
    const callLine = lines.find((l) => l.includes('"toolu_bash"') && l.includes('"tool_use"'))!;
    const resultLine = lines.find((l) => l.includes('"toolu_bash"') && l.includes('"tool_result"'))!;
    expect(n.push([callLine])).toMatchObject([{ kind: "tool", callId: "toolu_bash" }]);
    expect(n.push([resultLine])).toMatchObject([{ kind: "tool", callId: "toolu_bash", result: "# tests 7\n# pass 7" }]);
  });

  test("bad JSON lines are ignored", () => {
    expect(createNormalizer().push(["{not json", ""])).toEqual([]);
  });
});
