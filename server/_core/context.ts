import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { getUserByOpenId, upsertUser } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

// In offline/Electron mode, we auto-create a local user so no login is needed.
const OFFLINE_OPEN_ID = "local_midnight_drive_user";
const IS_OFFLINE = Boolean(process.env.MIDNIGHT_DRIVE_DATA_DIR);

async function getOrCreateOfflineUser(): Promise<User> {
  let user = await getUserByOpenId(OFFLINE_OPEN_ID);
  if (!user) {
    await upsertUser({
      openId: OFFLINE_OPEN_ID,
      name: "Midnight Drive",
      email: null,
      loginMethod: "local",
      role: "admin",
      lastSignedIn: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    user = await getUserByOpenId(OFFLINE_OPEN_ID);
  }
  return user!;
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  if (IS_OFFLINE) {
    // Desktop/offline mode: skip OAuth, auto-authenticate as local user
    try {
      user = await getOrCreateOfflineUser();
    } catch {
      user = null;
    }
  } else {
    try {
      user = await sdk.authenticateRequest(opts.req);
    } catch (error) {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
