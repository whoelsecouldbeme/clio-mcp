import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockClioGet, mockAppendAuditLog } = vi.hoisted(() => ({
  mockClioGet: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/clioClient.js", () => ({
  clioGet: mockClioGet,
  // Thin passthrough: the fallback path itself is covered against the real
  // helper in utils/__tests__/clioClient.test.ts.
  clioGetWithFieldFallback: async (path: string, params: any) => ({ body: await mockClioGet(path, params) }),
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
import { registerActivityDescriptionTools } from "../activityDescriptions.js";

type Handler = (args: Record<string, unknown>) => Promise<any>;

function buildServer(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const mockServer = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers[name] = handler; },
  } as unknown as McpServer;
  registerActivityDescriptionTools(mockServer);
  return handlers;
}

/** A UTBMS description exactly as Clio's v4 OpenAPI document shapes it: flat ids plus the code associations. */
const UTBMS_DESCRIPTION = {
  id: 501,
  name: "Review/analyze",
  description: "Review and analyze documents",
  type: "utbms",
  category_type: "hourly",
  default: false,
  visible_to_co_counsel: true,
  utbms_activity_id: 7104,
  utbms_task_id: 7120,
  utbms_task_name: "Analysis/Strategy",
  utbms_activity: { id: 7104, code: "A104", name: "Review/analyze" },
  utbms_task: { id: 7120, code: "L120", name: "Analysis/Strategy" },
  rate: { amount: 350, non_billable_amount: 0, type: "hourly", hierarchy: "user_default" },
};

const CLIO_DESCRIPTION = {
  id: 502,
  name: "Client Call",
  description: null,
  type: "clio",
  category_type: "hourly",
  default: true,
  visible_to_co_counsel: false,
  utbms_activity_id: null,
  utbms_task_id: null,
  utbms_task_name: null,
  utbms_activity: null,
  utbms_task: null,
  rate: null,
};

const parse = (r: any) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  mockAppendAuditLog.mockResolvedValue(undefined);
});

describe("list_activity_descriptions", () => {
  it("requests the documented field selection and forwards every filter as Clio spells it", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0 } });
    const h = buildServer();
    await h["list_activity_descriptions"]({ type: "utbms", flat_rate: false, user_id: 9, rate_for_matter_id: 42, rate_for_user_id: 9, limit: 50, page_token: "tok" });
    const [path, params] = mockClioGet.mock.calls[0];
    expect(path).toBe("/activity_descriptions.json");
    expect(params).toMatchObject({
      type: "utbms",
      flat_rate: "false",
      user_id: "9",
      "rate_for[matter_id]": "42",
      "rate_for[user_id]": "9",
      limit: "50",
      page_token: "tok",
    });
    expect(params.fields).toContain("utbms_task{id,code,name}");
    expect(params.fields).toContain("utbms_activity{id,code,name}");
    expect(params.fields).toContain("rate{amount,non_billable_amount,type,hierarchy}");
  });

  it("omits filters that were not supplied", async () => {
    mockClioGet.mockResolvedValue({ data: [], meta: { records: 0 } });
    const h = buildServer();
    await h["list_activity_descriptions"]({ limit: 200 });
    const [, params] = mockClioGet.mock.calls[0];
    expect(Object.keys(params).sort()).toEqual(["fields", "limit"]);
  });

  it("returns UTBMS codes with their code strings and the resolved rate", async () => {
    mockClioGet.mockResolvedValue({ data: [UTBMS_DESCRIPTION, CLIO_DESCRIPTION], meta: { records: 2 } });
    const h = buildServer();
    const out = parse(await h["list_activity_descriptions"]({ limit: 200 }));
    expect(out.activity_descriptions).toHaveLength(2);
    const [utbms, clio] = out.activity_descriptions;
    expect(utbms).toMatchObject({
      id: 501,
      name: "Review/analyze",
      prefill_note: "Review and analyze documents",
      type: "utbms",
      is_default: false,
      visible_to_co_counsel: true,
      utbms_task: { id: 7120, code: "L120", name: "Analysis/Strategy" },
      utbms_activity: { id: 7104, code: "A104", name: "Review/analyze" },
      rate: { amount: 350, non_billable_amount: 0, type: "hourly", hierarchy: "user_default" },
    });
    expect(clio).toMatchObject({ id: 502, is_default: true, utbms_task: null, utbms_activity: null, rate: null, prefill_note: null });
  });

  it("falls back to the flat UTBMS ids when Clio did not send the code associations", async () => {
    const { utbms_task, utbms_activity, rate, ...flatOnly } = UTBMS_DESCRIPTION;
    mockClioGet.mockResolvedValue({ data: [flatOnly], meta: { records: 1 } });
    const h = buildServer();
    const [d] = parse(await h["list_activity_descriptions"]({ limit: 200 })).activity_descriptions;
    expect(d.utbms_task).toEqual({ id: 7120, code: null, name: "Analysis/Strategy" });
    expect(d.utbms_activity).toEqual({ id: 7104, code: null, name: null });
    expect(d.rate).toBeNull();
  });

  it("paginates like the other list tools", async () => {
    mockClioGet.mockResolvedValue({
      data: [UTBMS_DESCRIPTION, CLIO_DESCRIPTION],
      meta: { records: 10, paging: { next: "https://app.clio.com/api/v4/activity_descriptions.json?page_token=next1" } },
    });
    const h = buildServer();
    const out = parse(await h["list_activity_descriptions"]({ limit: 2 }));
    expect(out.has_more).toBe(true);
    expect(out.next_page_token).toBe("next1");
    expect(out.total_count).toBe(10);
  });

  it("audit-logs only filters and counts", async () => {
    mockClioGet.mockResolvedValue({ data: [UTBMS_DESCRIPTION], meta: { records: 1 } });
    const h = buildServer();
    await h["list_activity_descriptions"]({ type: "utbms", rate_for_matter_id: 42, limit: 200 });
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry.tool).toBe("list_activity_descriptions");
    expect(entry.outcome).toBe("success");
    expect(entry.result_count).toBe(1);
    expect(entry.args).toMatchObject({ type: "utbms", rate_for_matter_id: 42, limit: 200 });
    expect(JSON.stringify(entry)).not.toContain("Review/analyze");
  });

  it("returns isError and audit-logs on an API failure", async () => {
    mockClioGet.mockRejectedValue(new Error("Clio API error 403: forbidden"));
    const h = buildServer();
    const r = await h["list_activity_descriptions"]({ limit: 200 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("403");
    expect(mockAppendAuditLog.mock.calls[0][0]).toMatchObject({ tool: "list_activity_descriptions", outcome: "error" });
  });
});

describe("list_utbms_codes", () => {
  const TASK = { id: 7120, name: "Analysis/Strategy", code: "L120", description: "Analysis and strategy", type: "UtbmsTask", utbms_set_id: 1 };
  const ACTIVITY = { id: 7104, name: "Review/analyze", code: "A104", description: null, type: "UtbmsActivity", utbms_set_id: 1 };

  it("hits Clio's nested /utbms/codes.json path with the type filter", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK], meta: { records: 1 } });
    const h = buildServer();
    await h["list_utbms_codes"]({ type: "UtbmsTask", utbms_set_id: 1, limit: 200 });
    const [path, params] = mockClioGet.mock.calls[0];
    expect(path).toBe("/utbms/codes.json");
    expect(params).toMatchObject({ type: "UtbmsTask", utbms_set_id: "1", limit: "200" });
    expect(params.fields).toBe("id,name,code,description,type,utbms_set_id");
  });

  it("returns id, code and name for each code", async () => {
    mockClioGet.mockResolvedValue({ data: [TASK, ACTIVITY], meta: { records: 2 } });
    const h = buildServer();
    const out = parse(await h["list_utbms_codes"]({ limit: 200 }));
    expect(out.utbms_codes).toEqual([
      { id: 7120, code: "L120", name: "Analysis/Strategy", description: "Analysis and strategy", type: "UtbmsTask", utbms_set_id: 1 },
      { id: 7104, code: "A104", name: "Review/analyze", description: null, type: "UtbmsActivity", utbms_set_id: 1 },
    ]);
    expect(out.has_more).toBe(false);
  });

  it("returns isError and audit-logs on an API failure", async () => {
    mockClioGet.mockRejectedValue(new Error("Clio API error 500"));
    const h = buildServer();
    const r = await h["list_utbms_codes"]({ limit: 200 });
    expect(r.isError).toBe(true);
    expect(mockAppendAuditLog.mock.calls[0][0]).toMatchObject({ tool: "list_utbms_codes", outcome: "error" });
  });
});
