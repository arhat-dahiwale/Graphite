import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";

export const helloRouter = router({
  /** Phase 0 hello-world procedure. */
  hello: publicProcedure
    .input(z.object({ name: z.string().max(100).optional() }).optional())
    .query(({ input }) => ({
      message: `hello from graphite api${input?.name ? `, ${input.name}` : ""}`,
      at: new Date().toISOString(),
    })),
});
