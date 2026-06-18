// Device registration + token persistence.
import * as SQLite from "expo-sqlite";

import { CONFIG } from "./config";

let cachedToken: string | null = null;

async function kv(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("roadsense.db");
  await db.execAsync("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  return db;
}

export async function getDeviceToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const db = await kv();
  const row = await db.getFirstAsync<{ v: string }>("SELECT v FROM kv WHERE k = 'token'");
  if (row?.v) return (cachedToken = row.v);

  const res = await fetch(`${CONFIG.API_BASE}/v1/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_version: "1.0.0" }),
  });
  const { token } = await res.json();
  await db.runAsync("INSERT OR REPLACE INTO kv (k, v) VALUES ('token', ?)", token);
  return (cachedToken = token);
}
