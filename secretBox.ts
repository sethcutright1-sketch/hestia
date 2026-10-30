// The AES-256-GCM format behind every encrypted value in the database (`enc:v1:<iv>:<tag>:<data>`,
// each part base64). Kept apart from db.ts, which takes its key from DB_ENCRYPTION_KEY and opens
// the database the moment it is imported: scripts/rotate-encryption-key.ts needs the same format
// with two explicit keys and its own database handle.
import crypto from "node:crypto";

export const ENCRYPTION_PREFIX = "enc:v1:";

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENCRYPTION_PREFIX);
}

/** A 32-byte key from 64 hex characters. `name` only labels the error; the value is never echoed. */
export function parseKey(hex: string | undefined, name: string): Buffer {
  if (!hex) throw new Error(`${name} is not set (see .env.example).`);
  const key = /^[0-9a-fA-F]{64}$/.test(hex.trim()) ? Buffer.from(hex.trim(), "hex") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error(`${name} must be a 32-byte key, hex-encoded (64 hex characters).`);
  return key;
}

export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTION_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Decrypts an `enc:v1:` value. Throws if the key is wrong (GCM's tag check), so a wrong key can
 *  never quietly produce garbage. A value without the prefix is returned unchanged: it was never
 *  encrypted (a row from before encryption, not yet migrated). */
export function decryptWithKey(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;
  const [ivB64, tagB64, dataB64] = value.slice(ENCRYPTION_PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
