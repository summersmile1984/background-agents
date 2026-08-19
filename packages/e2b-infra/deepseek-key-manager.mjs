import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function deepSeekKeyFingerprint(value) {
  if (!value) return null;
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function readKey(keyPath) {
  if (!keyPath) return null;
  try {
    return fs.readFileSync(keyPath, "utf8").trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicWrite(keyPath, value) {
  const directory = path.dirname(keyPath);
  const temporaryPath = `${keyPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${value}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  try {
    fs.renameSync(temporaryPath, keyPath);
    fs.chmodSync(keyPath, 0o600);
    syncDirectory(directory);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function createFileBackedDeepSeekKeyManager(keyPath) {
  let current = readKey(keyPath);
  return {
    get() {
      return current;
    },
    status() {
      return {
        configured: Boolean(current),
        fingerprint: deepSeekKeyFingerprint(current),
      };
    },
    replace(value) {
      const normalized = String(value || "").trim();
      if (!normalized) throw new Error("DeepSeek API key is required");
      if (!keyPath) throw new Error("DEEPSEEK_API_KEY_FILE is not configured");
      atomicWrite(keyPath, normalized);
      current = normalized;
      return this.status();
    },
    remove() {
      if (!keyPath) throw new Error("DEEPSEEK_API_KEY_FILE is not configured");
      try {
        fs.unlinkSync(keyPath);
        syncDirectory(path.dirname(keyPath));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      current = null;
      return this.status();
    },
  };
}

export function createMemoryDeepSeekKeyManager(initialValue = null) {
  let current = initialValue;
  return {
    get: () => current,
    status: () => ({
      configured: Boolean(current),
      fingerprint: deepSeekKeyFingerprint(current),
    }),
    replace(value) {
      current = String(value || "").trim() || null;
      return this.status();
    },
    remove() {
      current = null;
      return this.status();
    },
  };
}
