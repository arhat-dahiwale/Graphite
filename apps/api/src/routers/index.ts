import { router } from "../trpc";
import { helloRouter } from "./hello";
import { orgRouter } from "./org";
import { memberRouter } from "./member";
import { projectRouter } from "./project";
import { datasetRouter } from "./dataset";
import { dashboardRouter } from "./dashboard";
import { chartRouter } from "./chart";

export const appRouter = router({
  hello: helloRouter,
  org: orgRouter,
  member: memberRouter,
  project: projectRouter,
  dataset: datasetRouter,
  dashboard: dashboardRouter,
  chart: chartRouter,
});

export type AppRouter = typeof appRouter;
