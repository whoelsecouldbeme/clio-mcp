import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockClioGet, mockClioPost, mockClioPatch, mockClioDelete, mockClioGetAllPages, mockAppendAuditLog, MockClioApiError } = vi.hoisted(() => {
  class MockClioApiError extends Error {
    constructor(public readonly statusCode: number, message: string) { super(message); this.name = "ClioApiError"; }
  }
  return {
    mockClioGet: vi.fn(),
    mockClioPost: vi.fn(),
    mockClioPatch: vi.fn(),
    mockClioDelete: vi.fn(),
    mockClioGetAllPages: vi.fn(),
    mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
    MockClioApiError,
  };
});

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
  clioPatch: mockClioPatch,
  clioDelete: mockClioDelete,
  clioGetAllPages: mockClioGetAllPages,
  ClioApiError: MockClioApiError,
  extractNextPageToken: (meta: any) => {
    const nextUrl = meta?.paging?.next;
    if (!nextUrl) return null;
    try { return new URL(nextUrl).searchParams.get("page_token"); }
    catch { return null; }
  },
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActivityTools } from "../activities.js";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function buildServer(): { handlers: Record<string, Handler> } {
  const handlers: Record<string, Handler> = {};
  const mockServer = {
    registerTool: (_name: string, _schema: unknown, handler: Handler) => {
      handlers[_name] = handler;
    },
  } as unknown as McpServer;
  registerActivityTools(mockServer);
  return { handlers };
}

const FAKE_ENTRY = {
  id: 99,
  type: "TimeEntry",
  date: "2026-01-15",
  quantity_in_hours: 1.5,
  price: 300,
  total: 450,
  note: "Research",
  non_billable: false,
  matter: { id: 1, display_number: "2026-0001" },
  user: { id: 7, name: "Alice" },
};

const DESCRIPTIONS = [
  { id: 501, name: "Legal research", default: false, utbms_task: { id: 1, code: "L110", name: "Fact Investigation" }, utbms_activity: { id: 2, code: "A104", name: "Review/analyze" } },
  { id: 502, name: "Pleadings drafting", default: false, utbms_task: { id: 3, code: "L210", name: "Pleadings" }, utbms_activity: { id: 4, code: "A103", name: "Draft/revise" } },
  { id: 503, name: "Pleadings review", default: false, utbms_task: { id: 3, code: "L210", name: "Pleadings" }, utbms_activity: { id: 2, code: "A104", name: "Review/analyze" } },
  { id: 504, name: "Uncoded", default: true, utbms_task: null, utbms_activity: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
  mockClioPost.mockResolvedValue({ data: FAKE_ENTRY });
  mockClioPatch.mockResolvedValue({ data: FAKE_ENTRY });
  mockClioDelete.mockResolvedValue(undefined);
  mockClioGetAllPages.mockResolvedValue(DESCRIPTIONS);
});

// ─── list_time_entries ────────────────────────────────────────────────────────

describe("list_time_entries", () => {
  it("returns has_more: false and next_page_token: null on a short final page", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_ENTRY], meta: { records: 1, paging: {} } });
    const { handlers } = buildServer();
    const result = await handlers["list_time_entries"]({ limit: 25 }) as any;
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });

  it("returns has_more: true and the extracted token when a next page cursor is present", async () => {
    const twoEntries = [FAKE_ENTRY, { ...FAKE_ENTRY, id: 100 }];
    mockClioGet.mockResolvedValue({
      data: twoEntries,
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/activities.json?page_token=abc123" } },
    });
    const { handlers } = buildServer();
    const result = await handlers["list_time_entries"]({ limit: 2 }) as any;
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_page_token).toBe("abc123");
  });

  it("forwards page_token into the outgoing request params when supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [FAKE_ENTRY], meta: { records: 1 } });
    const { handlers } = buildServer();
    await handlers["list_time_entries"]({ limit: 25, page_token: "xyz" });
    expect(mockClioGet).toHaveBeenCalledWith(
      "/activities.json",
      expect.objectContaining({ page_token: "xyz" }),
    );
  });

  it("returns a JSON result with has_more: false when the page is empty, not a plain-text sentinel", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0, paging: {} } });
    const { handlers } = buildServer();
    const result = await handlers["list_time_entries"]({ limit: 25 }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.time_entries).toEqual([]);
    expect(parsed.has_more).toBe(false);
    expect(parsed.next_page_token).toBeNull();
  });
});

// ─── log_time_entry ───────────────────────────────────────────────────────────

describe("log_time_entry", () => {
  it("converts hours to seconds in the clioPost payload", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1.5 });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.quantity).toBe(5400);
  });

  it("excludes optional fields from payload when not provided", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1 });
    const [, body] = mockClioPost.mock.calls[0];
    const payload = (body as any).data;
    expect(payload).not.toHaveProperty("note");
    expect(payload).not.toHaveProperty("price");
    expect(payload).not.toHaveProperty("non_billable");
    expect(payload).not.toHaveProperty("no_charge");
    expect(payload).not.toHaveProperty("activity_description");
    expect(payload).not.toHaveProperty("user");
  });

  it("includes optional fields in payload when provided", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({
      matter_id: 1, date: "2026-01-15", quantity_in_hours: 2,
      note: "Drafting", price: 350, non_billable: true, no_charge: false,
      activity_description_id: 42, user_id: 7,
    });
    const [, body] = mockClioPost.mock.calls[0];
    const payload = (body as any).data;
    expect(payload.note).toBe("Drafting");
    expect(payload.price).toBe(350);
    expect(payload.non_billable).toBe(true);
    expect(payload.no_charge).toBe(false);
    expect(payload.activity_description).toEqual({ id: 42 });
    expect(payload.user).toEqual({ id: 7 });
  });

  it("audit-logs full args on success", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({
      matter_id: 1, date: "2026-01-15", quantity_in_hours: 1.5,
      note: "Research", price: 300, non_billable: false, no_charge: true,
      activity_description_id: 5, user_id: 7,
    });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log_time_entry",
      outcome: "success",
      args: expect.objectContaining({
        matter_id: 1,
        quantity_in_hours: 1.5,
        price: 300,
        non_billable: false,
        no_charge: true,
        activity_description_id: 5,
        user_id: 7,
      }),
    }));
  });

  it("audit-logs full args on API error", async () => {
    mockClioPost.mockRejectedValueOnce(new Error("network failure"));
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({
      matter_id: 1, date: "2026-01-15", quantity_in_hours: 1,
      price: 200, non_billable: true,
    }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log_time_entry",
      outcome: "error",
      error_message: "network failure",
      args: expect.objectContaining({ price: 200, non_billable: true }),
    }));
  });
});

// ─── create_activity ──────────────────────────────────────────────────────────

describe("create_activity", () => {
  it("rejects TimeEntry missing quantity_in_hours without calling clioPost", async () => {
    const { handlers } = buildServer();
    const result = await handlers["create_activity"]({
      type: "TimeEntry", date: "2026-01-15",
    }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/quantity_in_hours is required/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("audit-logs validation error when TimeEntry is missing quantity_in_hours", async () => {
    const { handlers } = buildServer();
    await handlers["create_activity"]({ type: "TimeEntry", date: "2026-01-15", matter_id: 1 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_activity",
      outcome: "error",
      error_message: "quantity_in_hours is required for TimeEntry",
      matter_id: 1,
    }));
  });

  it("converts hours to seconds for TimeEntry", async () => {
    const { handlers } = buildServer();
    await handlers["create_activity"]({
      type: "TimeEntry", date: "2026-01-15", quantity_in_hours: 2,
    });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.quantity).toBe(7200);
  });

  it("allows ExpenseEntry without quantity_in_hours", async () => {
    mockClioPost.mockResolvedValueOnce({ data: { ...FAKE_ENTRY, type: "ExpenseEntry", quantity_in_hours: null } });
    const { handlers } = buildServer();
    const result = await handlers["create_activity"]({
      type: "ExpenseEntry", date: "2026-01-15", price: 50,
    }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockClioPost).toHaveBeenCalledOnce();
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data).not.toHaveProperty("quantity");
  });

  it("audit-logs full args on success", async () => {
    const { handlers } = buildServer();
    await handlers["create_activity"]({
      type: "TimeEntry", date: "2026-01-15", matter_id: 1,
      quantity_in_hours: 1, price: 200, non_billable: false,
      no_charge: true, activity_description_id: 8, user_id: 3,
    });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_activity",
      outcome: "success",
      args: expect.objectContaining({
        type: "TimeEntry",
        quantity_in_hours: 1,
        price: 200,
        non_billable: false,
        no_charge: true,
        activity_description_id: 8,
        user_id: 3,
      }),
    }));
  });

  it("audit-logs full args on API error", async () => {
    mockClioPost.mockRejectedValueOnce(new Error("timeout"));
    const { handlers } = buildServer();
    const result = await handlers["create_activity"]({
      type: "TimeEntry", date: "2026-01-15", quantity_in_hours: 1,
      price: 150, non_billable: true,
    }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_activity",
      outcome: "error",
      error_message: "timeout",
      args: expect.objectContaining({ price: 150, non_billable: true }),
    }));
  });
});

// ─── silent-drop regressions ─────────────────────────────────────────────────

describe("log_time_entry: note alias and UTBMS codes", () => {
  it("accepts the entry text as `description` and sends it as Clio's `note`", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, description: "Drafted motion" }) as any;
    expect(result.isError).toBeUndefined();
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.note).toBe("Drafted motion");
  });

  it("refuses `note` and `description` with different values before writing", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, note: "a", description: "b" }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("resolves a UTBMS task/activity pair to the saved activity description id", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, note: "x", utbms_task_code: "l210", utbms_activity_code: "A103" }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockClioGetAllPages).toHaveBeenCalledWith("/activity_descriptions.json", expect.objectContaining({ fields: expect.stringContaining("utbms_task") }));
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.activity_description).toEqual({ id: 502 });
    expect((body as any).data).not.toHaveProperty("utbms_task_code");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      args: expect.objectContaining({ activity_description_id: 502, utbms_task_code: "l210" }),
    }));
  });

  it("fails without writing when no saved description carries the codes", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, utbms_task_code: "L999", utbms_activity_code: "A104" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No saved activity description carries UTBMS task L999 \+ activity A104/);
    expect(result.content[0].text).toContain("501");
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("fails without writing when the pair is ambiguous", async () => {
    mockClioGetAllPages.mockResolvedValue([...DESCRIPTIONS, { ...DESCRIPTIONS[1], id: 599, name: "Duplicate" }]);
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, utbms_task_code: "L210", utbms_activity_code: "A103" }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/2 saved activity descriptions/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("refuses codes together with activity_description_id", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, activity_description_id: 5, utbms_task_code: "L210" }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPost).not.toHaveBeenCalled();
  });

  it("rounds hours to whole seconds", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1.1 });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.quantity).toBe(3960);
  });

  it("echoes note and activity_description in the response", async () => {
    mockClioPost.mockResolvedValue({ data: { ...FAKE_ENTRY, activity_description: { id: 502, name: "Pleadings drafting" } } });
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, note: "Research", utbms_task_code: "L210", utbms_activity_code: "A103" }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.time_entry.note).toBe("Research");
    expect(parsed.time_entry.activity_description).toEqual({ id: 502, name: "Pleadings drafting", utbms_task_code: "L210", utbms_activity_code: "A103" });
  });
});

describe("list_activity_descriptions", () => {
  it("returns every description with its codes", async () => {
    const { handlers } = buildServer();
    const result = await handlers["list_activity_descriptions"]({ utbms_only: false }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_count).toBe(4);
    expect(parsed.activity_descriptions[0]).toEqual({
      id: 501, name: "Legal research", default: false,
      utbms_task_code: "L110", utbms_task_name: "Fact Investigation",
      utbms_activity_code: "A104", utbms_activity_name: "Review/analyze",
    });
  });

  it("filters by code, case-insensitively", async () => {
    const { handlers } = buildServer();
    const result = await handlers["list_activity_descriptions"]({ utbms_task_code: "l210", utbms_only: false }) as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.activity_descriptions.map((d: any) => d.id)).toEqual([502, 503]);
  });
});

describe("update_time_entry", () => {
  it("patches only the fields given, with hours converted", async () => {
    const { handlers } = buildServer();
    const result = await handlers["update_time_entry"]({ activity_id: 99, quantity_in_hours: 0.5, description: "Fixed" }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockClioPatch).toHaveBeenCalledWith("/activities/99.json", { data: { quantity: 1800, note: "Fixed" } }, expect.objectContaining({ fields: expect.any(String) }));
  });

  it("resolves UTBMS codes on update", async () => {
    const { handlers } = buildServer();
    await handlers["update_time_entry"]({ activity_id: 99, utbms_task_code: "L110", utbms_activity_code: "A104" });
    const [, body] = mockClioPatch.mock.calls[0];
    expect((body as any).data).toEqual({ activity_description: { id: 501 } });
  });

  it("rejects an update with nothing to change", async () => {
    const { handlers } = buildServer();
    const result = await handlers["update_time_entry"]({ activity_id: 99 }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioPatch).not.toHaveBeenCalled();
  });

  it("reports a missing entry as not_found", async () => {
    mockClioPatch.mockRejectedValueOnce(new MockClioApiError(404, "not found"));
    const { handlers } = buildServer();
    const result = await handlers["update_time_entry"]({ activity_id: 99, note: "x" }) as any;
    expect(result.isError).toBe(true);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "update_time_entry", outcome: "not_found" }));
  });
});

describe("delete_time_entry", () => {
  it("reads the entry, then deletes a time entry that is not billed", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 99, type: "TimeEntry", billed: false, date: "2026-01-15", quantity_in_hours: 1, note: "x", matter: { id: 1, display_number: "2026-0001" } } });
    const { handlers } = buildServer();
    const result = await handlers["delete_time_entry"]({ activity_id: 99 }) as any;
    expect(result.isError).toBeUndefined();
    expect(mockClioDelete).toHaveBeenCalledWith("/activities/99.json");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "delete_time_entry", outcome: "success", matter_id: 1 }));
    expect(JSON.parse(result.content[0].text).deleted.id).toBe(99);
  });

  it("refuses to delete an expense", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 99, type: "ExpenseEntry", billed: false } });
    const { handlers } = buildServer();
    const result = await handlers["delete_time_entry"]({ activity_id: 99 }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only time entries can be deleted/);
    expect(mockClioDelete).not.toHaveBeenCalled();
  });

  it("refuses to delete a billed entry", async () => {
    mockClioGet.mockResolvedValue({ data: { id: 99, type: "TimeEntry", billed: true } });
    const { handlers } = buildServer();
    const result = await handlers["delete_time_entry"]({ activity_id: 99 }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioDelete).not.toHaveBeenCalled();
  });

  it("reports a missing entry as not_found", async () => {
    mockClioGet.mockRejectedValueOnce(new MockClioApiError(404, "not found"));
    const { handlers } = buildServer();
    const result = await handlers["delete_time_entry"]({ activity_id: 99 }) as any;
    expect(result.isError).toBe(true);
    expect(mockClioDelete).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_found" }));
  });
});
