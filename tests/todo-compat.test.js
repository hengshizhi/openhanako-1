/**
 * todo-compat.js — legacy format migration pure function tests
 *
 * Covers:
 * - migrateLegacyTodos: old {id,text,done} → new {content,activeForm,status}
 * - migrateLegacyTodos: new format passthrough (idempotent)
 * - migrateLegacyTodos: edge cases (null, undefined, empty)
 * - extractLatestTodos: scan sourceMessages for latest todo tool_result
 * - extractLatestTodos: both "todo" and "todo_write" tool names
 * - extractLatestTodos: legacy format auto-converts
 */
import { describe, it, expect, vi } from "vitest";
import { migrateLegacyTodos, extractLatestTodos } from "../lib/tools/todo-compat.js";

describe("migrateLegacyTodos", () => {
  it("converts legacy {id, text, done: false} to pending", () => {
    const legacy = {
      action: "add",
      todos: [{ id: 1, text: "读取 spec", done: false }],
      nextId: 2,
    };
    const result = migrateLegacyTodos(legacy);
    expect(result).toEqual([
      { content: "读取 spec", activeForm: "读取 spec", status: "pending" },
    ]);
  });

  it("converts legacy {id, text, done: true} to completed", () => {
    const legacy = {
      action: "toggle",
      todos: [{ id: 1, text: "读取 spec", done: true }],
      nextId: 2,
    };
    const result = migrateLegacyTodos(legacy);
    expect(result).toEqual([
      { content: "读取 spec", activeForm: "读取 spec", status: "completed" },
    ]);
  });

  it("passes through new format unchanged (idempotent)", () => {
    const newFormat = {
      todos: [
        { content: "分析", activeForm: "正在分析", status: "in_progress" },
      ],
    };
    const result = migrateLegacyTodos(newFormat);
    expect(result).toEqual([
      { content: "分析", activeForm: "正在分析", status: "in_progress" },
    ]);
  });

  it("handles empty todos array", () => {
    expect(migrateLegacyTodos({ todos: [] })).toEqual([]);
  });

  it("returns [] for null/undefined details", () => {
    expect(migrateLegacyTodos(null)).toEqual([]);
    expect(migrateLegacyTodos(undefined)).toEqual([]);
    expect(migrateLegacyTodos({})).toEqual([]);
  });

  it("returns [] when todos field is missing", () => {
    expect(migrateLegacyTodos({ action: "list" })).toEqual([]);
  });

  it("handles mixed legacy + partial new-format items safely", () => {
    const mixed = {
      todos: [
        { id: 1, text: "legacy", done: false },
        { content: "new", activeForm: "正在 new", status: "pending" },
      ],
    };
    const result = migrateLegacyTodos(mixed);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ content: "legacy", activeForm: "legacy", status: "pending" });
    expect(result[1]).toEqual({ content: "new", activeForm: "正在 new", status: "pending" });
  });

  it("sanitizes unknown/corrupt items to a legal default", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const garbage = {
      todos: [
        { foo: "bar" },
        { content: "has content", status: "bogus_state" },
        null,
      ],
    };
    const result = migrateLegacyTodos(garbage);
    expect(result).toHaveLength(3);
    for (const item of result) {
      expect(typeof item.content).toBe("string");
      expect(typeof item.activeForm).toBe("string");
      expect(["pending", "in_progress", "completed"]).toContain(item.status);
    }
    // 第二条有 content 字段，应保留；状态非法回填为 pending
    expect(result[1].content).toBe("has content");
    expect(result[1].status).toBe("pending");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("extractLatestTodos", () => {
  it("returns null when no todo tool result in messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(extractLatestTodos(messages)).toBe(null);
  });

  it("finds last toolResult with toolName='todo' (legacy)", () => {
    const messages = [
      { role: "user", content: "task" },
      {
        role: "toolResult",
        toolName: "todo",
        details: {
          action: "add",
          todos: [{ id: 1, text: "step1", done: false }],
          nextId: 2,
        },
      },
    ];
    const result = extractLatestTodos(messages);
    expect(result).toEqual([
      { content: "step1", activeForm: "step1", status: "pending" },
    ]);
  });

  it("finds last toolResult with toolName='todo_write' (new)", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "todo_write",
        details: {
          todos: [
            { content: "step1", activeForm: "正在 step1", status: "in_progress" },
          ],
        },
      },
    ];
    const result = extractLatestTodos(messages);
    expect(result).toEqual([
      { content: "step1", activeForm: "正在 step1", status: "in_progress" },
    ]);
  });

  it("returns only the latest when multiple todo tool results exist", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "todo",
        details: { todos: [{ id: 1, text: "old", done: false }], nextId: 2 },
      },
      {
        role: "toolResult",
        toolName: "todo_write",
        details: { todos: [{ content: "new", activeForm: "正在 new", status: "pending" }] },
      },
    ];
    const result = extractLatestTodos(messages);
    expect(result).toEqual([
      { content: "new", activeForm: "正在 new", status: "pending" },
    ]);
  });

  it("skips non-toolResult entries", () => {
    const messages = [
      { role: "assistant", content: "..." },
      {
        role: "toolResult",
        toolName: "todo",
        details: { todos: [{ id: 1, text: "x", done: false }], nextId: 2 },
      },
      { role: "user", content: "..." },
    ];
    const result = extractLatestTodos(messages);
    expect(result).not.toBe(null);
    expect(result).toHaveLength(1);
  });

  it("ignores toolResult with other tool names", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "read",
        details: { content: "file" },
      },
    ];
    expect(extractLatestTodos(messages)).toBe(null);
  });
});
