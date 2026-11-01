import { z } from "zod";
import { newId, notFound, quotaExceeded, unprocessable } from "@graphite/core";
import { agentRuns, agentSteps, conversations, datasets, dashboards, messages } from "@graphite/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Context } from "../context.js";
import { authedProcedure, router, toTrpcError } from "../trpc.js";
import { requireAuthorized } from "../authz-helpers.js";

const kindSchema = z.enum(["generate_dashboard", "remake_chart", "ask"]);

async function resolveRun(ctx: Context, runId: string) {
  const rows = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rows[0];
  if (!run) throw notFound();
  await requireAuthorized(ctx, run.organizationId, "dashboard:read", { type: "run" });
  return run;
}

export const runRouter = router({
  start: authedProcedure
    .input(
      z.object({
        dashboardId: z.string().min(1),
        datasetId: z.string().min(1).optional(),
        kind: kindSchema,
        prompt: z.string().min(1).max(4000),
        targetChartId: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const dashRows = await ctx.db
          .select()
          .from(dashboards)
          .where(eq(dashboards.id, input.dashboardId))
          .limit(1);
        const dash = dashRows[0];
        if (!dash || dash.deletedAt) throw notFound();
        await requireAuthorized(ctx, dash.organizationId, "agent:run", { type: "run" });

        // Org quota: agent runs per hour (API.md rate limits). Redis fixed
        // window keyed by org and hour bucket.
        const orgRunsPerHour = Number(process.env.ORG_RUNS_PER_HOUR ?? 30);
        if (orgRunsPerHour > 0) {
          const hourKey = `rl:org-runs:${dash.organizationId}:${Math.floor(Date.now() / 3_600_000)}`;
          const count = await ctx.redis.incr(hourKey);
          if (count === 1) {
            await ctx.redis.expire(hourKey, 3600);
          }
          if (count > orgRunsPerHour) {
            throw quotaExceeded(
              `Org agent-run quota reached (${orgRunsPerHour}/hour). Try again later.`,
            );
          }
        }

        // Resolve the dataset: explicit, or the first ready dataset in the
        // dashboard's project.
        let datasetId = input.datasetId ?? null;
        if (!datasetId) {
          const dsRows = await ctx.db
            .select()
            .from(datasets)
            .where(and(eq(datasets.projectId, dash.projectId), eq(datasets.status, "ready")))
            .orderBy(asc(datasets.createdAt))
            .limit(1);
          datasetId = dsRows[0]?.id ?? null;
        }
        if (!datasetId) {
          throw unprocessable("No ready dataset in this project to run the agent on");
        }
        const dsCheck = await ctx.db
          .select()
          .from(datasets)
          .where(eq(datasets.id, datasetId))
          .limit(1);
        if (!dsCheck[0] || dsCheck[0].organizationId !== dash.organizationId) {
          throw notFound();
        }

        // One conversation per dashboard+user, reused across runs.
        const existingConv = await ctx.db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.dashboardId, input.dashboardId),
              eq(conversations.createdBy, ctx.user.id),
            ),
          )
          .limit(1);
        const conversation =
          existingConv[0] ??
          (
            await ctx.db
              .insert(conversations)
              .values({
                organizationId: dash.organizationId,
                dashboardId: input.dashboardId,
                createdBy: ctx.user.id,
              })
              .returning()
          )[0];
        if (!conversation) throw new Error("Failed to resolve conversation");

        const runId = newId("run");
        await ctx.db.insert(agentRuns).values({
          id: runId,
          organizationId: dash.organizationId,
          conversationId: conversation.id,
          dashboardId: input.dashboardId,
          datasetId,
          targetChartId: input.targetChartId ?? null,
          kind: input.kind,
          status: "queued",
          model:
            process.env.LLM_PROVIDER === "anthropic"
              ? (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")
              : "mock-scripted",
          createdBy: ctx.user.id,
        });
        await ctx.db.insert(messages).values({
          conversationId: conversation.id,
          role: "user",
          content: input.prompt,
          runId,
        });
        await ctx.db.insert(messages).values({
          conversationId: conversation.id,
          role: "assistant",
          content:
            input.kind === "remake_chart"
              ? "Re-making the chart now — watch the steps below."
              : "Building your dashboard now — watch the steps below.",
          runId,
        });
        await ctx.enqueueAgentRun(runId);
        return { runId, conversationId: conversation.id };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  get: authedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const run = await resolveRun(ctx, input.runId);
        const steps = await ctx.db
          .select()
          .from(agentSteps)
          .where(eq(agentSteps.runId, run.id))
          .orderBy(asc(agentSteps.stepIndex));
        return { run, steps };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  list: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const dashRows = await ctx.db
          .select()
          .from(dashboards)
          .where(eq(dashboards.id, input.dashboardId))
          .limit(1);
        const dash = dashRows[0];
        if (!dash || dash.deletedAt) throw notFound();
        await requireAuthorized(ctx, dash.organizationId, "dashboard:read", { type: "run" });
        return ctx.db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.dashboardId, input.dashboardId))
          .orderBy(desc(agentRuns.createdAt))
          .limit(50);
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  cancel: authedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const run = await resolveRun(ctx, input.runId);
        // The orchestrator checks this flag between steps.
        await ctx.db
          .update(agentRuns)
          .set({ cancelRequested: true })
          .where(eq(agentRuns.id, run.id));
        return { ok: true };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),

  conversation: authedProcedure
    .input(z.object({ dashboardId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      try {
        const dashRows = await ctx.db
          .select()
          .from(dashboards)
          .where(eq(dashboards.id, input.dashboardId))
          .limit(1);
        const dash = dashRows[0];
        if (!dash || dash.deletedAt) throw notFound();
        await requireAuthorized(ctx, dash.organizationId, "dashboard:read", { type: "run" });
        const convRows = await ctx.db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.dashboardId, input.dashboardId),
              eq(conversations.createdBy, ctx.user.id),
            ),
          )
          .limit(1);
        const conv = convRows[0];
        if (!conv) return { conversationId: null, messages: [] };
        const rows = await ctx.db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conv.id))
          .orderBy(asc(messages.createdAt))
          .limit(200);
        return { conversationId: conv.id, messages: rows };
      } catch (e) {
        throw toTrpcError(e);
      }
    }),
});
