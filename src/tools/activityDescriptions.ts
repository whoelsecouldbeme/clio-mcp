import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import z from "zod";
import { clioGet, clioGetWithFieldFallback, extractNextPageToken } from "../utils/clioClient.js";
import { appendAuditLog } from "../utils/auditLog.js";

/**
 * Everything on ActivityDescription_base in Clio's v4 OpenAPI document. The
 * UTBMS ids are flat attributes there, so this selection cannot be rejected for
 * an unknown association and is what a rejected rich selection falls back to.
 */
const ACTIVITY_DESCRIPTION_BASE_FIELDS =
  "id,name,description,type,category_type,default,visible_to_co_counsel,utbms_activity_id,utbms_task_id,utbms_task_name";

/**
 * The associations Clio documents on ActivityDescription: the two UTBMS codes as
 * objects (which carry the code string, e.g. "A104" / "L120", that the flat ids
 * do not) and the resolved rate. `rate` is only populated when the request
 * carries `rate_for[...]`; otherwise Clio returns it null.
 */
const ACTIVITY_DESCRIPTION_FIELDS =
  `${ACTIVITY_DESCRIPTION_BASE_FIELDS},utbms_task{id,code,name},utbms_activity{id,code,name},rate{amount,non_billable_amount,type,hierarchy}`;

const UTBMS_CODE_FIELDS = "id,name,code,description,type,utbms_set_id";

/** A UTBMS code as we return it: the association when Clio sent it, else what the flat id tells us. */
function mapUtbmsCode(assoc: any, flatId: number | undefined, flatName?: string): { id: number; code: string | null; name: string | null } | null {
  if (assoc?.id) return { id: assoc.id, code: assoc.code ?? null, name: assoc.name ?? null };
  if (flatId) return { id: flatId, code: null, name: flatName ?? null };
  return null;
}

export function registerActivityDescriptionTools(server: McpServer): void {
  server.registerTool(
    "list_activity_descriptions",
    {
      description:
        "List the firm's activity descriptions (billing categories) with their IDs, which is what log_time_entry and create_activity take as activity_description_id. " +
        "UTBMS descriptions come back with their task and activity codes attached. Pass rate_for_matter_id to see the hourly rate each description resolves to on a matter.",
      inputSchema: {
        type: z.enum(["utbms", "clio"]).optional().describe("Only UTBMS descriptions (utbms) or only the firm's own custom ones (clio)"),
        flat_rate: z.boolean().optional().describe("Only flat-rate descriptions (true) or only hourly ones (false)"),
        user_id: z.number().int().positive().optional().describe("Only descriptions this user can record time against"),
        rate_for_matter_id: z.number().int().positive().optional().describe("Resolve each description's rate as it would apply on this matter"),
        rate_for_user_id: z.number().int().positive().optional().describe("Resolve rates for this user instead of the authenticated user"),
        limit: z.number().int().min(1).max(200).default(200).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_activity_descriptions response to fetch the next page"),
      },
    },
    async ({ type, flat_rate, user_id, rate_for_matter_id, rate_for_user_id, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: ACTIVITY_DESCRIPTION_FIELDS,
          limit: String(limit),
        };
        if (type) params["type"] = type;
        if (flat_rate !== undefined) params["flat_rate"] = String(flat_rate);
        if (user_id !== undefined) params["user_id"] = String(user_id);
        if (rate_for_matter_id !== undefined) params["rate_for[matter_id]"] = String(rate_for_matter_id);
        if (rate_for_user_id !== undefined) params["rate_for[user_id]"] = String(rate_for_user_id);
        if (page_token) params["page_token"] = page_token;

        const { body: data, fields_warning } = await clioGetWithFieldFallback(
          "/activity_descriptions.json",
          params,
          ACTIVITY_DESCRIPTION_BASE_FIELDS
        );
        const descriptions = data.data as any[];
        const nextPageToken = descriptions.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_activity_descriptions",
          args: { type, flat_rate, user_id, rate_for_matter_id, rate_for_user_id, limit, page_token },
          outcome: "success",
          result_count: descriptions?.length ?? 0,
        });

        const result = {
          activity_descriptions: descriptions.map((d) => ({
            id: d.id,
            name: d.name,
            // Clio pre-fills the time entry's note with this when the description is picked.
            prefill_note: d.description ?? null,
            type: d.type ?? null,
            category_type: d.category_type ?? null,
            is_default: d.default ?? false,
            visible_to_co_counsel: d.visible_to_co_counsel ?? false,
            utbms_task: mapUtbmsCode(d.utbms_task, d.utbms_task_id, d.utbms_task_name),
            utbms_activity: mapUtbmsCode(d.utbms_activity, d.utbms_activity_id),
            rate: d.rate
              ? {
                  amount: d.rate.amount ?? null,
                  non_billable_amount: d.rate.non_billable_amount ?? null,
                  type: d.rate.type ?? null,
                  hierarchy: d.rate.hierarchy ?? null,
                }
              : null,
          })),
          total_count: data.meta?.records ?? descriptions.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
          ...(fields_warning && { fields_warning }),
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_activity_descriptions",
          args: { type, flat_rate, user_id, rate_for_matter_id, rate_for_user_id, limit, page_token },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "list_utbms_codes",
    {
      description:
        "List UTBMS codes (LEDES task codes such as L120, activity codes such as A104, and expense codes such as E101) with the IDs that " +
        "log_time_entry and create_activity take as utbms_task_id / utbms_activity_id. Filter by type to get just tasks or just activities.",
      inputSchema: {
        type: z.enum(["UtbmsTask", "UtbmsActivity", "UtbmsExpense"]).optional().describe("Only codes of this kind"),
        utbms_set_id: z.number().int().positive().optional().describe("Only codes from this UTBMS code set (e.g. Litigation vs Bankruptcy)"),
        limit: z.number().int().min(1).max(200).default(200).describe("Max results to return (1-200)"),
        page_token: z.string().optional().describe("Cursor from a previous list_utbms_codes response to fetch the next page"),
      },
    },
    async ({ type, utbms_set_id, limit, page_token }) => {
      try {
        const params: Record<string, string> = {
          fields: UTBMS_CODE_FIELDS,
          limit: String(limit),
        };
        if (type) params["type"] = type;
        if (utbms_set_id !== undefined) params["utbms_set_id"] = String(utbms_set_id);
        if (page_token) params["page_token"] = page_token;

        const data = await clioGet("/utbms/codes.json", params);
        const codes = data.data as any[];
        const nextPageToken = codes.length >= limit ? extractNextPageToken(data.meta) : null;

        await appendAuditLog({
          tool: "list_utbms_codes",
          args: { type, utbms_set_id, limit, page_token },
          outcome: "success",
          result_count: codes?.length ?? 0,
        });

        const result = {
          utbms_codes: codes.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            description: c.description ?? null,
            type: c.type ?? null,
            utbms_set_id: c.utbms_set_id ?? null,
          })),
          total_count: data.meta?.records ?? codes.length,
          has_more: nextPageToken !== null,
          next_page_token: nextPageToken,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        await appendAuditLog({
          tool: "list_utbms_codes",
          args: { type, utbms_set_id, limit, page_token },
          outcome: "error",
          error_message: err.message,
        });
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
}
