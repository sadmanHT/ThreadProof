import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function decodeDataKey(base64: string) {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("THREADPROOF_DATA_KEY_BASE64 must decode to exactly 32 bytes");
  return key;
}

export function byteaToBuffer(value: string) {
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  if (value.startsWith("0x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(value, "base64");
}

export function bufferToBytea(value: Buffer) {
  return `\\x${value.toString("hex")}`;
}

export function encryptEmbedded(plaintext: string, key: Buffer) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), nonce, ciphertext, tag]);
}

export function decryptEmbedded(blob: Buffer, key: Buffer) {
  if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== VERSION) {
    throw new Error("Unsupported encrypted scalar envelope");
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptDetached(plaintext: string, key: Buffer) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]) };
}

export function decryptDetached(ciphertextWithTag: Buffer, nonce: Buffer, key: Buffer) {
  if (nonce.length !== NONCE_BYTES || ciphertextWithTag.length < TAG_BYTES) {
    throw new Error("Invalid detached AES-GCM payload");
  }
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_BYTES);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
