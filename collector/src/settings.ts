// Persisted user settings (SQLite kv, same DB as the buffer/token).
// `wifiOnly` is read synchronously by the uploader/drive logic, so it's cached
// in memory and loaded once at startup.
import * as SQLite from "expo-sqlite";

import { CONFIG } from "./config";

let cache = { wifiOnly: CONFIG.WIFI_ONLY_DEFAULT };

async function kv(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync("roadsense.db");
  await db.execAsync("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
  return db;
}

export async function loadSettings(): Promise<typeof cache> {
  const db = await kv();
  const row = await db.getFirstAsync<{ v: string }>("SELECT v FROM kv WHERE k = 'wifiOnly'");
  if (row) cache.wifiOnly = row.v === "1";
  return cache;
}

export function wifiOnly(): boolean {
  return cache.wifiOnly;
}

export async function setWifiOnly(on: boolean): Promise<void> {
  cache.wifiOnly = on;
  const db = await kv();
  await db.runAsync("INSERT OR REPLACE INTO kv (k, v) VALUES ('wifiOnly', ?)", on ? "1" : "0");
}
