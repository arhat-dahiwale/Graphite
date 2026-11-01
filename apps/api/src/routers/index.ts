import { router } from "../trpc.js";
import { helloRouter } from "./hello.js";
import { orgRouter } from "./org.js";
import { memberRouter } from "./member.js";
import { projectRouter } from "./project.js";
import { datasetRouter } from "./dataset.js";

export const appRouter = router({
  hello: helloRouter,
  org: orgRouter,
  member: memberRouter,
  project: projectRouter,
  dataset: datasetRouter,
});

export type AppRouter = typeof appRouter;
