import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockClioGet, mockClioPost, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockClioPost: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  clioPost: mockClioPost,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
  mockClioPost.mockResolvedValue({ data: FAKE_ENTRY });
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

// ─── UTBMS codes on time entries ──────────────────────────────────────────────

describe("log_time_entry UTBMS codes", () => {
  it("nests utbms_task_id and utbms_activity_id under activity_description, as Clio's Activity#create expects", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, utbms_task_id: 7120, utbms_activity_id: 7104 });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.activity_description).toEqual({ utbms_task_id: 7120, utbms_activity_id: 7104 });
  });

  it("sends the description id alongside the codes when all three are given", async () => {
    const { handlers } = buildServer();
    await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, activity_description_id: 42, utbms_task_id: 7120, utbms_activity_id: 7104 });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.activity_description).toEqual({ id: 42, utbms_task_id: 7120, utbms_activity_id: 7104 });
  });

  it("rejects a lone utbms_task_id without a description id, before any request goes out", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, utbms_task_id: 7120 }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be sent together/);
    expect(mockClioPost).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tool: "log_time_entry", outcome: "error", matter_id: 1,
      args: expect.objectContaining({ utbms_task_id: 7120 }),
    }));
  });

  it("allows a lone UTBMS id when activity_description_id already names a UTBMS description", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, activity_description_id: 42, utbms_activity_id: 7104 }) as any;
    expect(result.isError).toBeUndefined();
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.activity_description).toEqual({ id: 42, utbms_activity_id: 7104 });
  });

  it("asks Clio to echo the attached description and reports it in the confirmation", async () => {
    mockClioPost.mockResolvedValue({ data: { ...FAKE_ENTRY, activity_description: { id: 42, name: "Review/analyze", utbms_task_id: 7120, utbms_activity_id: 7104 } } });
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1, activity_description_id: 42 }) as any;
    const [, , params] = mockClioPost.mock.calls[0];
    expect((params as any).fields).toContain("activity_description{id,name,utbms_task_id,utbms_activity_id}");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.time_entry.activity_description).toEqual({ id: 42, name: "Review/analyze", utbms_task_id: 7120, utbms_activity_id: 7104 });
  });

  it("reports a null activity_description when the entry has none", async () => {
    const { handlers } = buildServer();
    const result = await handlers["log_time_entry"]({ matter_id: 1, date: "2026-01-15", quantity_in_hours: 1 }) as any;
    expect(JSON.parse(result.content[0].text).time_entry.activity_description).toBeNull();
  });
});

describe("create_activity UTBMS codes", () => {
  it("nests the codes under activity_description for a TimeEntry", async () => {
    const { handlers } = buildServer();
    await handlers["create_activity"]({ type: "TimeEntry", date: "2026-01-15", matter_id: 1, quantity_in_hours: 0.5, utbms_task_id: 7120, utbms_activity_id: 7104 });
    const [, body] = mockClioPost.mock.calls[0];
    expect((body as any).data.activity_description).toEqual({ utbms_task_id: 7120, utbms_activity_id: 7104 });
  });

  it("rejects a lone utbms_activity_id without a description id", async () => {
    const { handlers } = buildServer();
    const result = await handlers["create_activity"]({ type: "TimeEntry", date: "2026-01-15", matter_id: 1, quantity_in_hours: 0.5, utbms_activity_id: 7104 }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/must be sent together/);
    expect(mockClioPost).not.toHaveBeenCalled();
  });
});

describe("list_time_entries activity_description", () => {
  it("includes each entry's attached description, or null", async () => {
    mockClioGet.mockResolvedValue({
      data: [
        { ...FAKE_ENTRY, activity_description: { id: 42, name: "Review/analyze", utbms_task_id: 7120, utbms_activity_id: 7104 } },
        { ...FAKE_ENTRY, id: 100 },
      ],
      meta: { records: 2, paging: {} },
    });
    const { handlers } = buildServer();
    const result = await handlers["list_time_entries"]({ limit: 25 }) as any;
    const [with_, without] = JSON.parse(result.content[0].text).time_entries;
    expect(with_.activity_description).toEqual({ id: 42, name: "Review/analyze", utbms_task_id: 7120, utbms_activity_id: 7104 });
    expect(without.activity_description).toBeNull();
    const [, params] = mockClioGet.mock.calls[0];
    expect(params.fields).toContain("activity_description{id,name,utbms_task_id,utbms_activity_id}");
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
