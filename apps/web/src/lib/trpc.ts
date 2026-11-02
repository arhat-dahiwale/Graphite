"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../../api/src/routers/index";

export type { AppRouter };
export const trpc = createTRPCReact<AppRouter>();

export const trpcUrl = "/trpc";
