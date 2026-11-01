import { router } from "../trpc.js";
import { helloRouter } from "./hello.js";
import { orgRouter } from "./org.js";
import { memberRouter } from "./member.js";
import { projectRouter } from "./project.js";

export const appRouter = router({
  hello: helloRouter,
  org: orgRouter,
  member: memberRouter,
  project: projectRouter,
});

export type AppRouter = typeof appRouter;
