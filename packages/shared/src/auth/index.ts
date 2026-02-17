import path from "node:path";
import fs from "node:fs/promises";
import { HOME_DIR } from "../constants";

export interface OAuthCredentials {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
}

export interface ApiKeyCredentials {
  type: "api";
  key: string;
}

export type AuthInfo = OAuthCredentials | ApiKeyCredentials;

const AUTH_FILE = path.join(HOME_DIR, "auth.json");

export async function getAuth(providerID: string): Promise<AuthInfo | undefined> {
  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    const data = JSON.parse(content);
    return data[providerID] as AuthInfo | undefined;
  } catch {
    return undefined;
  }
}

export async function getAllAuth(): Promise<Record<string, AuthInfo>> {
  try {
    const content = await fs.readFile(AUTH_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export async function setAuth(providerID: string, info: AuthInfo): Promise<void> {
  await fs.mkdir(HOME_DIR, { recursive: true });
  const data = await getAllAuth();
  data[providerID] = info;
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2));
  try {
    await fs.chmod(AUTH_FILE, 0o600);
  } catch {
    // Permissions may not be supported on all platforms
  }
}

export async function removeAuth(providerID: string): Promise<void> {
  const data = await getAllAuth();
  delete data[providerID];
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2));
  try {
    await fs.chmod(AUTH_FILE, 0o600);
  } catch {
    // Permissions may not be supported on all platforms
  }
}
