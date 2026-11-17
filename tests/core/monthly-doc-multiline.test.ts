import { describe, it, expect } from "vitest";
import { parseMonthlyDoc, serializeMonthlyDoc, upsertEvents } from "../../src/core/monthly-doc";
import { AgendaEvent, escapeMultiline, unescapeMultiline } from "../../src/core/event";

const desc = "- priority:: high;\n- deliverable::\n\t- [ ] Rename folder;\n\t- [ ] Install plugins.";

const ev: AgendaEvent = {
  uid: "a@x",
  title: "Migrate",
  start: "2026-10-07T11:30:00",
  end: "2026-10-07T15:30:00",
  description: desc,
  category: "PrivateⳆSub",
};

function roundTrip(value: string): string {
  const { text } = upsertEvents("# 2026-10\n", [{ ...ev, description: value }]);
  return unescapeMultiline(parseMonthlyDoc(text).blocks[0].fields.description);
}

describe("multi-line description in monthly docs", () => {
  it("writes each line indented by one tab under `- description::`", () => {
    const { text } = upsertEvents("# 2026-10\n", [ev]);
    expect(text).toContain(
      "- description::\n\t- priority:: high;\n\t- deliverable::\n\t\t- [ ] Rename folder;\n\t\t- [ ] Install plugins.\n- category:: PrivateⳆSub",
    );
    expect(text).not.toContain("\\n");
  });

  it("reads it back to the exact same value and keeps the fields after it", () => {
    const { text } = upsertEvents("# 2026-10\n", [ev]);
    const b = parseMonthlyDoc(text).blocks[0];
    expect(b.fields.description).toBe(escapeMultiline(desc));
    expect(b.fields.category).toBe("PrivateⳆSub");
    expect(b.prose).toBe("");
  });

  it("round-trips blank lines, backslashes and lines that all start with a tab", () => {
    for (const v of ["a\n\nb", "a\n", "C:\\dir\\n\nnext", "\tx\n\ty", "  two\n    four"]) {
      expect(roundTrip(v)).toBe(v);
    }
  });

  it("keeps single-line descriptions inline", () => {
    const { text } = upsertEvents("# 2026-10\n", [{ ...ev, description: "one line" }]);
    expect(text).toContain("- description:: one line\n");
  });

  it("still reads the old escaped one-line form", () => {
    const old = "## 11:30 X\n- uid:: a@x\n- start:: 2026-10-07T11:30:00\n- description:: a\\n\tb\n- category:: c\n";
    const b = parseMonthlyDoc(old).blocks[0];
    expect(unescapeMultiline(b.fields.description)).toBe("a\n\tb");
    expect(b.fields.category).toBe("c");
  });

  it("reads hand-typed space-indented lines and an inline first line", () => {
    const src = "## X\n- uid:: a@x\n- description:: Intro\n    - one\n      - nested\n- category:: c\n\nnotes\n";
    const b = parseMonthlyDoc(src).blocks[0];
    expect(unescapeMultiline(b.fields.description)).toBe("Intro\n- one\n  - nested");
    expect(b.fields.category).toBe("c");
    expect(b.prose).toBe("notes");
  });

  it("does not treat indented lines after other fields as part of them", () => {
    const src = "## X\n- uid:: a@x\n- location:: here\n\tnot a field\n";
    const b = parseMonthlyDoc(src).blocks[0];
    expect(b.fields.location).toBe("here");
    expect(b.prose).toBe("\tnot a field");
  });

  it("leaves the file unchanged when nothing changed", () => {
    const { text } = upsertEvents("# 2026-10\n", [ev]);
    const { preamble, blocks } = parseMonthlyDoc(text);
    expect(serializeMonthlyDoc(preamble, blocks)).toBe(text);
    expect(upsertEvents(text, [ev]).updated).toBe(0);
  });
});
