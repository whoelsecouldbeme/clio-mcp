import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioGetAllPages, clioPost, clioPatch, clioDelete, ClioApiError, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

// Only one level of brace nesting: Clio rejects a second level (see 2.2.1).
const ACTIVITY_FIELDS =
  "id,type,date,quantity_in_hours,price,total,note,non_billable,no_charge,matter{id,display_number},user{id,name},activity_description{id,name}";

const ACTIVITY_DESCRIPTION_FIELDS = "id,name,default,utbms_task{id,code,name},utbms_activity{id,code,name}";

const HOURS_DESCRIPTION =
  "Hours worked as a JSON number, not a string (e.g. 1.5 for 90 minutes, 0.1 for 6 minutes). Converted to seconds for Clio.";

const UTBMS_TASK_DESCRIPTION =
  "UTBMS task code such as \"L210\". Resolved to the matching saved activity description (see list_activity_descriptions) and sent as activity_description_id. Errors if no saved description carries this code. Cannot be combined with activity_description_id.";
const UTBMS_ACTIVITY_DESCRIPTION =
  "UTBMS activity code such as \"A104\". Resolved together with utbms_task_code; a saved activity description must exist with exactly this task/activity pair. Cannot be combined with activity_description_id.";

/** Seconds for Clio, rounded so 1.1 h does not become 3960.0000000000005. */
export function hoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

export interface ActivityDescriptionSummary {
  id: number;
  name: string;
  default: boolean;
  utbms_task_code: string | null;
  utbms_task_name: string | null;
  utbms_activity_code: string | null;
  utbms_activity_name: string | null;
}

function summariseDescription(d: any): ActivityDescriptionSummary {
  return {
    id: d.id,
    name: d.name,
    default: d.default ?? false,
    utbms_task_code: d.utbms_task?.code ?? null,
    utbms_task_name: d.utbms_task?.name ?? null,
    utbms_activity_code: d.utbms_activity?.code ?? null,
    utbms_activity_name: d.utbms_activity?.name ?? null,
  };
}

async function fetchAllActivityDescriptions(): Promise<ActivityDescriptionSummary[]> {
  const rows = await clioGetAllPages("/activity_descriptions.json", {
    fields: ACTIVITY_DESCRIPTION_FIELDS,
    limit: "200",
  });
  return rows.map(summariseDescription);
}

export class UtbmsResolutionError extends Error {
  constructor(message: string, public readonly candidates: ActivityDescriptionSummary[]) {
    super(message);
    this.name = "UtbmsResolutionError";
  }
}

/**
 * Clio attaches UTBMS codes to a time entry only through a saved activity
 * description that carries the task/activity pair. Sending raw codes on the
 * activity body is accepted by Clio and ignored, which is how blank-coded
 * entries got created. So codes are resolved here, and a code with no saved
 * description fails loudly instead of producing an uncoded entry.
 */
export async function resolveUtbmsActivityDescription(
  taskCode: string | undefined,
  activityCode: string | undefined,
): Promise<ActivityDescriptionSummary> {
  const all = await fetchAllActivityDescriptions();
  const coded = all.filter((d) => d.utbms_task_code !== null || d.utbms_activity_code !== null);
  const wantTask = taskCode !== undefined ? normaliseCode(taskCode) : undefined;
  const wantActivity = activityCode !== undefined ? normaliseCode(activityCode) : undefined;

  const matches = coded.filter((d) => {
    const task = d.utbms_task_code ? normaliseCode(d.utbms_task_code) : null;
    const activity = d.utbms_activity_code ? normaliseCode(d.utbms_activity_code) : null;
    if (wantTask !== undefined && task !== wantTask) return false;
    if (wantActivity !== undefined && activity !== wantActivity) return false;
    // When only one code was given, prefer descriptions that carry only that code.
    if (wantTask === undefined && task !== null) return false;
    if (wantActivity === undefined && activity !== null) return false;
    return true;
  });

  const asked = [wantTask && `task ${wantTask}`, wantActivity && `activity ${wantActivity}`].filter(Boolean).join(" + ");

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    throw new UtbmsResolutionError(
      `${matches.length} saved activity descriptions carry UTBMS ${asked}; pass one of them as activity_description_id instead: ` +
        matches.map((m) => `${m.id} (${m.name})`).join(", "),
      matches,
    );
  }

  const near = coded.filter((d) => {
    const task = d.utbms_task_code ? normaliseCode(d.utbms_task_code) : null;
    const activity = d.utbms_activity_code ? normaliseCode(d.utbms_activity_code) : null;
    return (wantTask !== undefined && task === wantTask) || (wantActivity !== undefined && activity === wantActivity);
  });
  const hint = near.length
    ? ` Descriptions carrying one of these codes: ${near.slice(0, 10).map((m) => `${m.id} (${m.name}: ${m.utbms_task_code ?? "-"}/${m.utbms_activity_code ?? "-"})`).join(", ")}.`
    : coded.length
      ? ` ${coded.length} UTBMS-coded activity descriptions exist; call list_activity_descriptions to see them.`
      : " This account has no UTBMS-coded activity descriptions; create one in Clio (Settings > Activity Descriptions) first.";
  throw new UtbmsResolutionError(
    `No saved activity description carries UTBMS ${asked}, so the entry was not created.${hint}`,
    near,
  );
}

/** Shared narrative for the tool descriptions: the two mistakes that produced blank and uncoded entries. */
const WRITE_CONTRACT =
  " Unknown parameters are rejected rather than ignored. The entry text goes in `note` (`description` is accepted as an alias). " +
  "UTBMS codes are attached via `activity_description_id`, or via `utbms_task_code`/`utbms_activity_code`, which are resolved to a saved activity description; raw codes are never sent to Clio on their own.";

function formatEntry(entry: any, resolved?: ActivityDescriptionSummary | null) {
  return {
    id: entry.id,
    type: entry.type ?? null,
    date: entry.date,
    quantity_in_hours: entry.quantity_in_hours ?? null,
    rate: entry.price ?? null,
    total: entry.total ?? null,
    note: entry.note ?? null,
    non_billable: entry.non_billable ?? false,
    no_charge: entry.no_charge ?? false,
    matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
    user: entry.user ? { id: entry.user.id, name: entry.user.name } : null,
    activity_description: entry.activity_description
      ? {
          id: entry.activity_description.id,
          name: entry.activity_description.name ?? resolved?.name ?? null,
          utbms_task_code: resolved?.utbms_task_code ?? null,
          utbms_activity_code: resolved?.utbms_activity_code ?? null,
        }
      : null,
  };
}

/** Pick the note text from `note` or its alias `description`; both set and different is a caller error. */
function pickNote(note: string | undefined, description: string | undefined): { note?: string; error?: string } {
  if (note !== undefined && description !== undefined && note !== description) {
    return { error: "Provide the entry text as `note` (or `description`), not both with different values." };
  }
  return { note: note ?? description };
}

export function registerActivityTools(server: McpServer): void {
  server.registerTool(
    "list_time_entries",
    {
      description: "List time entries (billable hours) from Clio",
      inputSchema: {
        matter_id: z.number().int().positive().optional().describe("Filter by matter ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — entries on or after this date"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("ISO date (YYYY-MM-DD) — entries on or before this date"),
        limit: z.number().int().min(1).max(200).default(25).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_time_entries response to fetch the next page"),
      },
    },
    async ({ matter_id, start_date, end_date, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: ACTIVITY_FIELDS,
          limit: String(limit),
          type: "TimeEntry",
        };
        if (matter_id) params["matter_id"] = String(matter_id);
        if (start_date) params["start_date"] = start_date;
        if (end_date) params["end_date"] = end_date;
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/activities.json", params);
        const entries = data.data as any[];
        const nextPageToken = entries.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_time_entries",
          args: { matter_id, start_date, end_date, limit, page_token },
          outcome: "success",
          result_count: entries?.length ?? 0,
          ...(matter_id && { matter_id }),
        });

        const result = {
          time_entries: entries.map((e) => ({
            id: e.id,
            date: e.date,
            quantity_in_hours: e.quantity_in_hours,
            rate: e.price ?? null,
            total: e.total,
            description: e.note ?? null,
            non_billable: e.non_billable ?? false,
            matter: e.matter ? { id: e.matter.id, display_number: e.matter.display_number } : null,
            user: e.user ? { id: e.user.id, name: e.user.name } : null,
            activity_description: e.activity_description
              ? { id: e.activity_description.id, name: e.activity_description.name ?? null }
              : null,
          })),
          total_count: data.meta?.records ?? entries.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_time_entries",
          args: { matter_id, start_date, end_date, limit, page_token },
          outcome: "error",
          error_message: err.message,
          ...(matter_id && { matter_id }),
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_activity_descriptions",
    {
      description:
        "List the account's saved activity descriptions (billing codes) with their UTBMS task and activity codes. " +
        "Use the returned id as activity_description_id when logging time, or pass utbms_task_code/utbms_activity_code and let log_time_entry resolve it.",
      inputSchema: {
        utbms_task_code: z.string().optional().describe("Only descriptions carrying this UTBMS task code (e.g. L210)"),
        utbms_activity_code: z.string().optional().describe("Only descriptions carrying this UTBMS activity code (e.g. A104)"),
        utbms_only: z.boolean().default(false).describe("Only descriptions that carry at least one UTBMS code"),
      },
    },
    async ({ utbms_task_code, utbms_activity_code, utbms_only }) => {
      try {
        let rows = await fetchAllActivityDescriptions();
        if (utbms_only) rows = rows.filter((d) => d.utbms_task_code !== null || d.utbms_activity_code !== null);
        if (utbms_task_code !== undefined) {
          const want = normaliseCode(utbms_task_code);
          rows = rows.filter((d) => d.utbms_task_code !== null && normaliseCode(d.utbms_task_code) === want);
        }
        if (utbms_activity_code !== undefined) {
          const want = normaliseCode(utbms_activity_code);
          rows = rows.filter((d) => d.utbms_activity_code !== null && normaliseCode(d.utbms_activity_code) === want);
        }

        await appendAuditLog({
          tool: "list_activity_descriptions",
          args: { utbms_task_code, utbms_activity_code, utbms_only },
          outcome: "success",
          result_count: rows.length,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ activity_descriptions: rows, total_count: rows.length }, null, 2) }],
        };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_activity_descriptions",
          args: { utbms_task_code, utbms_activity_code, utbms_only },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "log_time_entry",
    {
      description:
        "Create a new billable (or non-billable) time entry on a Clio matter. Required: matter_id (number), date (YYYY-MM-DD), quantity_in_hours (number). " +
        "Use for time entries only; for expenses, hard costs, or soft costs use create_activity." + WRITE_CONTRACT,
      inputSchema: {
        matter_id: z.number().int().positive().describe("Matter ID to log time against"),
        date: z.string().date().describe("ISO date (YYYY-MM-DD) when work was performed"),
        quantity_in_hours: z.number().positive().describe(HOURS_DESCRIPTION),
        note: z.string().optional().describe("Description of work performed. This is the entry text Clio shows on the bill."),
        description: z.string().optional().describe("Alias for `note`. Use one or the other."),
        price: z.number().optional().describe("Hourly rate override; omit to use Clio rate hierarchy"),
        non_billable: z.boolean().optional().describe("Mark entry as non-billable (default: billable)"),
        no_charge: z.boolean().optional().describe("Show non-billable entry on bill anyway"),
        activity_description_id: z.number().int().positive().optional().describe("Saved activity description / billing code ID (from list_activity_descriptions). This is how UTBMS codes attach to an entry."),
        utbms_task_code: z.string().optional().describe(UTBMS_TASK_DESCRIPTION),
        utbms_activity_code: z.string().optional().describe(UTBMS_ACTIVITY_DESCRIPTION),
        user_id: z.number().int().positive().optional().describe("User to log time for; defaults to authenticated user"),
      },
    },
    async ({ matter_id, date, quantity_in_hours, note, description, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, user_id }) => {
      const auditArgs = { matter_id, date, quantity_in_hours, note, description, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, user_id };
      const fail = async (message: string) => {
        await appendAuditLog({ tool: "log_time_entry", args: auditArgs, outcome: "error", error_message: message, matter_id });
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      };

      const picked = pickNote(note, description);
      if (picked.error) return fail(picked.error);
      const wantsCodes = utbms_task_code !== undefined || utbms_activity_code !== undefined;
      if (wantsCodes && activity_description_id !== undefined) {
        return fail("Pass either activity_description_id or utbms_task_code/utbms_activity_code, not both.");
      }

      try {
        let resolved: ActivityDescriptionSummary | null = null;
        let descriptionId = activity_description_id;
        if (wantsCodes) {
          resolved = await resolveUtbmsActivityDescription(utbms_task_code, utbms_activity_code);
          descriptionId = resolved.id;
        }

        const activityData: Record<string, unknown> = {
          type: "TimeEntry",
          date,
          quantity: hoursToSeconds(quantity_in_hours),
          matter: { id: matter_id },
        };
        if (picked.note !== undefined)      activityData["note"] = picked.note;
        if (price !== undefined)            activityData["price"] = price;
        if (non_billable !== undefined)     activityData["non_billable"] = non_billable;
        if (no_charge !== undefined)        activityData["no_charge"] = no_charge;
        if (descriptionId !== undefined)    activityData["activity_description"] = { id: descriptionId };
        if (user_id !== undefined)          activityData["user"] = { id: user_id };

        const data = await clioPost("/activities.json", { data: activityData }, { fields: ACTIVITY_FIELDS });
        const entry = data.data;

        await appendAuditLog({
          tool: "log_time_entry",
          args: { ...auditArgs, activity_description_id: descriptionId },
          outcome: "success",
          matter_id,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, time_entry: formatEntry(entry, resolved) }, null, 2),
          }],
        };
      } catch (err: any) {
        return fail(err.message);
      }
    }
  );

  server.registerTool(
    "update_time_entry",
    {
      description:
        "Update fields on an existing Clio time entry (fix a blank note, attach a billing code, correct hours or date). " +
        "Only the fields passed are changed." + WRITE_CONTRACT,
      inputSchema: {
        activity_id: z.number().int().positive().describe("ID of the time entry (activity) to update, as returned by log_time_entry or list_time_entries"),
        date: z.string().date().optional().describe("New ISO date (YYYY-MM-DD)"),
        quantity_in_hours: z.number().positive().optional().describe(HOURS_DESCRIPTION),
        note: z.string().optional().describe("New entry text"),
        description: z.string().optional().describe("Alias for `note`. Use one or the other."),
        price: z.number().optional().describe("New hourly rate"),
        non_billable: z.boolean().optional().describe("Billable flag"),
        no_charge: z.boolean().optional().describe("Show non-billable entry on bill anyway"),
        activity_description_id: z.number().int().positive().optional().describe("Saved activity description / billing code ID to attach"),
        utbms_task_code: z.string().optional().describe(UTBMS_TASK_DESCRIPTION),
        utbms_activity_code: z.string().optional().describe(UTBMS_ACTIVITY_DESCRIPTION),
        matter_id: z.number().int().positive().optional().describe("Move the entry to this matter"),
        user_id: z.number().int().positive().optional().describe("Reassign the entry to this user"),
      },
    },
    async ({ activity_id, date, quantity_in_hours, note, description, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, matter_id, user_id }) => {
      const auditArgs = { activity_id, date, quantity_in_hours, note, description, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, matter_id, user_id };
      const fail = async (message: string, mid?: number) => {
        await appendAuditLog({ tool: "update_time_entry", args: auditArgs, outcome: "error", error_message: message, ...(mid !== undefined && { matter_id: mid }) });
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      };

      const picked = pickNote(note, description);
      if (picked.error) return fail(picked.error, matter_id);
      const wantsCodes = utbms_task_code !== undefined || utbms_activity_code !== undefined;
      if (wantsCodes && activity_description_id !== undefined) {
        return fail("Pass either activity_description_id or utbms_task_code/utbms_activity_code, not both.", matter_id);
      }
      if ([date, quantity_in_hours, picked.note, price, non_billable, no_charge, activity_description_id, matter_id, user_id].every((v) => v === undefined) && !wantsCodes) {
        return fail("At least one field to update must be provided.", matter_id);
      }

      try {
        let resolved: ActivityDescriptionSummary | null = null;
        let descriptionId = activity_description_id;
        if (wantsCodes) {
          resolved = await resolveUtbmsActivityDescription(utbms_task_code, utbms_activity_code);
          descriptionId = resolved.id;
        }

        const activityData: Record<string, unknown> = {};
        if (date !== undefined)               activityData["date"] = date;
        if (quantity_in_hours !== undefined)  activityData["quantity"] = hoursToSeconds(quantity_in_hours);
        if (picked.note !== undefined)        activityData["note"] = picked.note;
        if (price !== undefined)              activityData["price"] = price;
        if (non_billable !== undefined)       activityData["non_billable"] = non_billable;
        if (no_charge !== undefined)          activityData["no_charge"] = no_charge;
        if (descriptionId !== undefined)      activityData["activity_description"] = { id: descriptionId };
        if (matter_id !== undefined)          activityData["matter"] = { id: matter_id };
        if (user_id !== undefined)            activityData["user"] = { id: user_id };

        const data = await clioPatch(`/activities/${activity_id}.json`, { data: activityData }, { fields: ACTIVITY_FIELDS });
        const entry = data.data;
        const entryMatterId: number | undefined = entry?.matter?.id ?? matter_id;

        await appendAuditLog({
          tool: "update_time_entry",
          args: { ...auditArgs, activity_description_id: descriptionId },
          outcome: "success",
          ...(entryMatterId !== undefined && { matter_id: entryMatterId }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, time_entry: formatEntry(entry, resolved) }, null, 2),
          }],
        };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "update_time_entry", args: auditArgs, outcome: "not_found", error_message: err.message });
          return { content: [{ type: "text", text: `Error: time entry ${activity_id} was not found in Clio.` }], isError: true };
        }
        return fail(err.message, matter_id);
      }
    }
  );

  server.registerTool(
    "delete_time_entry",
    {
      description:
        "Delete a Clio time entry, for cleaning up an entry that was created wrongly. Refuses to delete anything that is not a TimeEntry " +
        "(expenses and costs are never deleted) and refuses entries that are already on a bill. This cannot be undone.",
      inputSchema: {
        activity_id: z.number().int().positive().describe("ID of the time entry (activity) to delete"),
      },
    },
    async ({ activity_id }) => {
      try {
        // Read first: the delete endpoint is shared by every activity type, and
        // the connector's contract is that only time entries can be removed.
        const current = await clioGet(`/activities/${activity_id}.json`, { fields: "id,type,date,quantity_in_hours,note,billed,matter{id,display_number}" });
        const entry = current?.data ?? {};
        const matterId: number | undefined = entry.matter?.id;
        if (entry.type !== "TimeEntry") {
          const message = `Activity ${activity_id} is a ${entry.type ?? "non-time"} entry; only time entries can be deleted through this connector.`;
          await appendAuditLog({ tool: "delete_time_entry", args: { activity_id }, outcome: "error", error_message: message, ...(matterId !== undefined && { matter_id: matterId }) });
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
        if (entry.billed === true) {
          const message = `Time entry ${activity_id} is already on a bill; remove it from the bill in Clio before deleting.`;
          await appendAuditLog({ tool: "delete_time_entry", args: { activity_id }, outcome: "error", error_message: message, ...(matterId !== undefined && { matter_id: matterId }) });
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }

        await clioDelete(`/activities/${activity_id}.json`);

        await appendAuditLog({
          tool: "delete_time_entry",
          args: { activity_id },
          outcome: "success",
          ...(matterId !== undefined && { matter_id: matterId }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              deleted: {
                id: activity_id,
                date: entry.date ?? null,
                quantity_in_hours: entry.quantity_in_hours ?? null,
                note: entry.note ?? null,
                matter: entry.matter ? { id: entry.matter.id, display_number: entry.matter.display_number } : null,
              },
            }, null, 2),
          }],
        };
      } catch (err: any) {
        if (err instanceof ClioApiError && err.statusCode === 404) {
          await appendAuditLog({ tool: "delete_time_entry", args: { activity_id }, outcome: "not_found", error_message: err.message });
          return { content: [{ type: "text", text: `Error: time entry ${activity_id} was not found in Clio.` }], isError: true };
        }
        await appendAuditLog({ tool: "delete_time_entry", args: { activity_id }, outcome: "error", error_message: err.message });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "create_activity",
    {
      description:
        "Create a Clio activity — TimeEntry, ExpenseEntry, HardCostEntry, or SoftCostEntry. For time entries on a matter, prefer log_time_entry. " +
        "quantity_in_hours is a JSON number and is required for TimeEntry." + WRITE_CONTRACT,
      inputSchema: {
        type: z.enum(["TimeEntry", "ExpenseEntry", "HardCostEntry", "SoftCostEntry"]).describe("Activity type"),
        date: z.string().date().describe("ISO date (YYYY-MM-DD) when the activity occurred"),
        matter_id: z.number().int().positive().optional().describe("Matter ID to associate with"),
        note: z.string().optional().describe("Description / details"),
        description: z.string().optional().describe("Alias for `note`. Use one or the other."),
        quantity_in_hours: z.number().positive().optional().describe("Hours as a JSON number (TimeEntry only); converted to seconds internally"),
        price: z.number().optional().describe("Hourly rate (TimeEntry) or expense amount (Expense types)"),
        non_billable: z.boolean().optional().describe("Non-billable flag (TimeEntry only)"),
        no_charge: z.boolean().optional().describe("Show non-billable on bill"),
        activity_description_id: z.number().int().positive().optional().describe("Saved activity description / billing code ID"),
        utbms_task_code: z.string().optional().describe(UTBMS_TASK_DESCRIPTION),
        utbms_activity_code: z.string().optional().describe(UTBMS_ACTIVITY_DESCRIPTION),
        user_id: z.number().int().positive().optional().describe("User to associate; defaults to authenticated user"),
        reference: z.string().optional().describe("Check reference (HardCostEntry only)"),
        tax_setting: z.enum(["no_tax", "tax_1_only", "tax_2_only", "tax_1_and_tax_2"]).optional().describe("Tax setting (expense entries)"),
      },
    },
    async ({ type, date, matter_id, note, description, quantity_in_hours, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, user_id, reference, tax_setting }) => {
      const auditArgs = { type, date, matter_id, note, description, quantity_in_hours, price, non_billable, no_charge, activity_description_id, utbms_task_code, utbms_activity_code, user_id, reference, tax_setting };
      const fail = async (message: string) => {
        await appendAuditLog({ tool: "create_activity", args: auditArgs, outcome: "error", error_message: message, ...(matter_id !== undefined && { matter_id }) });
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      };

      if (type === "TimeEntry" && quantity_in_hours === undefined) {
        return fail("quantity_in_hours is required for TimeEntry");
      }
      const picked = pickNote(note, description);
      if (picked.error) return fail(picked.error);
      const wantsCodes = utbms_task_code !== undefined || utbms_activity_code !== undefined;
      if (wantsCodes && activity_description_id !== undefined) {
        return fail("Pass either activity_description_id or utbms_task_code/utbms_activity_code, not both.");
      }

      try {
        let resolved: ActivityDescriptionSummary | null = null;
        let descriptionId = activity_description_id;
        if (wantsCodes) {
          resolved = await resolveUtbmsActivityDescription(utbms_task_code, utbms_activity_code);
          descriptionId = resolved.id;
        }

        const activityData: Record<string, unknown> = { type, date };
        if (matter_id !== undefined)          activityData["matter"] = { id: matter_id };
        if (picked.note !== undefined)        activityData["note"] = picked.note;
        if (quantity_in_hours !== undefined)  activityData["quantity"] = hoursToSeconds(quantity_in_hours);
        if (price !== undefined)              activityData["price"] = price;
        if (non_billable !== undefined)       activityData["non_billable"] = non_billable;
        if (no_charge !== undefined)          activityData["no_charge"] = no_charge;
        if (descriptionId !== undefined)      activityData["activity_description"] = { id: descriptionId };
        if (user_id !== undefined)            activityData["user"] = { id: user_id };
        if (reference !== undefined)          activityData["reference"] = reference;
        if (tax_setting !== undefined)        activityData["tax_setting"] = tax_setting;

        const data = await clioPost("/activities.json", { data: activityData }, { fields: ACTIVITY_FIELDS });
        const entry = data.data;

        await appendAuditLog({
          tool: "create_activity",
          args: { ...auditArgs, activity_description_id: descriptionId },
          outcome: "success",
          ...(matter_id !== undefined && { matter_id }),
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, activity: { ...formatEntry(entry, resolved), price: entry.price ?? null } }, null, 2),
          }],
        };
      } catch (err: any) {
        return fail(err.message);
      }
    }
  );
}
