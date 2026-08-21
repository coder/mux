import { test, expect } from "bun:test";
import { handleStringReplace, handleLineReplace } from "./file_edit_replace_shared";

test("file_edit_replace_string error includes agent note field", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "nonexistent",
      new_string: "replacement",
    },
    "some file content"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("old_string not found");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});

test("file_edit_replace_string ambiguous match error includes note", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "duplicate",
      new_string: "replacement",
    },
    "duplicate text with duplicate word"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("appears 2 times");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});

test("file_edit_replace_lines validation error includes note", () => {
  const result = handleLineReplace(
    {
      path: "test.ts",
      start_line: 10,
      end_line: 9,
      new_lines: ["new content"],
    },
    "line 1\nline 2"
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error).toContain("end_line must be >= start_line");
    expect(result.note).toBeDefined();
    expect(result.note).toContain("EDIT FAILED");
    expect(result.note).toContain("file was NOT modified");
  }
});

test("file_edit_replace_string replace_count=2 with new_string containing old_string replaces both original sites", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "old",
      new_string: "XoldY",
      replace_count: 2,
    },
    "AoldB-oldC"
  );

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.newContent).toBe("AXoldYB-XoldYC");
    expect(result.metadata.edits_applied).toBe(2);
  }
});

test("file_edit_replace_string replace_count=-1 with new_string containing old_string replaces all sites", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "old",
      new_string: "XoldY",
      replace_count: -1,
    },
    "AoldB-oldC-oldD"
  );

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.newContent).toBe("AXoldYB-XoldYC-XoldYD");
    expect(result.metadata.edits_applied).toBe(3);
  }
});

test("file_edit_replace_string replace_count=2 with non-overlapping strings replaces first two occurrences", () => {
  const result = handleStringReplace(
    {
      path: "test.ts",
      old_string: "foo",
      new_string: "bar",
      replace_count: 2,
    },
    "foo one foo two foo three"
  );

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.newContent).toBe("bar one bar two foo three");
    expect(result.metadata.edits_applied).toBe(2);
  }
});
