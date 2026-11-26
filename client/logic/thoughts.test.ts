import { describe, expect, test } from "vitest";
import type { ThoughtEvent } from "./events";
import { addThought, emptyLane, interrupt, tickThoughts } from "./thoughts";

let n = 0;
const thought = (text: string, source: ThoughtEvent["source"] = "reasoning", key = `a:thought:${n++}`): ThoughtEvent => ({
  key, agentId: "a", agentLabel: "claude", at: "t", status: "completed", kind: "thought", source, text,
});

describe("addThought", () => {
  test("growing snapshots become one thought", () => {
    let l = addThought(emptyLane, thought("I am"), { instant: false });
    l = addThought(l, thought("I am reading"), { instant: false });
    expect(l.items.map((t) => t.text)).toEqual(["I am reading"]);
  });

  test("the same key with a fuller copy replaces the text", () => {
    let l = addThought(emptyLane, thought("final", "message", "a:msg:1"), { instant: false });
    l = addThought(l, thought("final answer", "message", "a:msg:1"), { instant: false });
    expect(l.items.map((t) => t.text)).toEqual(["final answer"]);
  });

  test("pieces of reasoning in a row join into one thought", () => {
    let l = addThought(emptyLane, thought("I am "), { instant: false });
    l = addThought(l, thought("reading"), { instant: false });
    expect(l.items.map((t) => t.text)).toEqual(["I am reading"]);
  });

  test("something else happening in between starts a new thought", () => {
    let l = addThought(emptyLane, thought("first idea"), { instant: false });
    l = interrupt(l);
    l = addThought(l, thought("second idea"), { instant: false });
    expect(l.items.map((t) => t.text)).toEqual(["first idea", "second idea"]);
  });

  test("a message after reasoning is a separate thought", () => {
    let l = addThought(emptyLane, thought("thinking"), { instant: false });
    l = addThought(l, thought("Here is the answer", "message"), { instant: false });
    expect(l.items.map((t) => t.source)).toEqual(["reasoning", "message"]);
  });

  test("keeps only the last six", () => {
    let l = emptyLane;
    for (const text of ["one", "two", "three", "four", "five", "six", "seven"]) {
      l = addThought(interrupt(l), thought(text), { instant: false });
    }
    expect(l.items.map((t) => t.text)).toEqual(["two", "three", "four", "five", "six", "seven"]);
  });

  test("a new thought finishes the previous one instantly", () => {
    let l = addThought(emptyLane, thought("a long first thought"), { instant: false });
    l = addThought(interrupt(l), thought("next"), { instant: false });
    expect(l.items[0].shown).toBe("a long first thought".length);
    expect(l.items[1].shown).toBe(0);
  });

  test("history thoughts appear fully", () => {
    const l = addThought(emptyLane, thought("from history"), { instant: true });
    expect(l.items[0].shown).toBe("from history".length);
  });
});

describe("tickThoughts", () => {
  test("types about 150 characters a second", () => {
    let l = addThought(emptyLane, thought("x".repeat(500)), { instant: false });
    l = tickThoughts(l, 1000);
    expect(l.items[0].shown).toBe(150);
  });

  test("an idle lane is returned unchanged", () => {
    const l = addThought(emptyLane, thought("done"), { instant: true });
    expect(tickThoughts(l, 50)).toBe(l);
  });
});
