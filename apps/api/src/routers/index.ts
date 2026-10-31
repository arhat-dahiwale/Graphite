import { router } from "../trpc.js";
import { helloRouter } from "./hello.js";

export const appRouter = router({
  hello: helloRouter,
});

export type AppRouter = typeof appRouter;
