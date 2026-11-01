import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import type { Database } from "@graphite/db/client";
import { users, sessions, accounts, verifications } from "@graphite/db/schema";
import type { SessionUser } from "./context.js";

export interface AuthOptions {
  db: Database;
  secret: string;
  baseUrl: string;
  webUrl: string;
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
}

export interface GraphiteAuth {
  handler: ReturnType<typeof toNodeHandler>;
  resolveSession: (headers: Request["headers"]) => Promise<SessionUser | null>;
  verifyInviteOrigin: () => string;
}

/**
 * Better Auth instance: email + password, optional OAuth providers, sessions
 * in Postgres. Orgs/members/invitations are Graphite-owned tables (DATA.md);
 * Better Auth manages only users/sessions/accounts/verifications.
 */
export function createAuth(options: AuthOptions): GraphiteAuth {
  const socialProviders: Record<string, unknown> = {};
  if (options.google) {
    socialProviders.google = {
      clientId: options.google.clientId,
      clientSecret: options.google.clientSecret,
    };
  }
  if (options.github) {
    socialProviders.github = {
      clientId: options.github.clientId,
      clientSecret: options.github.clientSecret,
    };
  }

  const auth = betterAuth({
    appName: "graphite",
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: [options.webUrl, "http://localhost:3000", "http://127.0.0.1:3000"],
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    // Graphite column names differ from Better Auth defaults for accounts.
    account: {
      fields: {
        providerId: "provider",
        accountId: "providerAccountId",
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh once a day
    },
    socialProviders,
    advanced: {
      database: {
        generateId: (): string => `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      },
    },
  });

  return {
    handler: toNodeHandler(auth),
    resolveSession: async (headers) => {
      const result = await auth.api.getSession({
        headers: fromNodeHeaders(headers),
      });
      if (!result?.user) return null;
      return {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
      };
    },
    verifyInviteOrigin: () => options.webUrl,
  };
}
