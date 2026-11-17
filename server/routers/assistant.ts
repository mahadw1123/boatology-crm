import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { assistantEnabled, askAssistant, takeAssistantQuota, AssistantError } from "../_core/assistant";

// ============================================================================
// STAFF HELP ASSISTANT (answers from the built-in guide only; sees no CRM data)
// ============================================================================

export const assistantRouter = router({
  status: protectedProcedure.query(({ ctx }) => ({
    enabled: ctx.user.role !== "customer" && assistantEnabled(),
  })),

  ask: protectedProcedure
    .input(
      z.object({
        messages: z
          // Assistant answers sent back as history can be long; only what
          // staff type is held to the shorter limit (checked below).
          .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(10000) }))
          .min(1)
          .max(10)
          .refine((turns) => turns.every((turn) => turn.role !== "user" || turn.text.length <= 2000), {
            message: "Keep each question under 2000 characters.",
          }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role === "customer") throw new TRPCError({ code: "FORBIDDEN" });
      if (!assistantEnabled()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The help assistant has not been switched on yet. Ask an administrator." });
      }
      if (input.messages[input.messages.length - 1].role !== "user") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Ask a question first." });
      }
      if (!takeAssistantQuota(ctx.user.id)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "You have reached today's limit for the help assistant. Try again tomorrow, or ask an administrator." });
      }
      try {
        return { answer: await askAssistant(input.messages) };
      } catch (error) {
        console.error("Help assistant failed:", error);
        throw new TRPCError({
          // BAD_REQUEST so the screen shows this message as-is instead of the
          // generic "refresh the record" advice that suits record edits.
          code: "BAD_REQUEST",
          message: error instanceof AssistantError ? error.message : "The help assistant is unavailable right now. Please try again shortly.",
        });
      }
    }),
});
