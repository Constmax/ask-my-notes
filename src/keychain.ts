/**
 * Thin wrapper around Electron's safeStorage API.
 * Encrypts secrets via macOS Keychain / Windows DPAPI / Linux libsecret.
 * Falls back to plaintext storage if safeStorage is unavailable.
 */

interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

function getSafeStorage(): ElectronSafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).require?.("electron");
    const ss = electron?.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === "function" && ss.isEncryptionAvailable()) {
      return ss as ElectronSafeStorage;
    }
  } catch {
    // Electron not available (e.g. mobile)
  }
  return null;
}

/** Encrypt a secret. Returns a base64 string prefixed with "enc:" to distinguish from plaintext. */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const ss = getSafeStorage();
  if (!ss) return plaintext;
  try {
    const encrypted = ss.encryptString(plaintext);
    return "enc:" + Buffer.from(encrypted).toString("base64");
  } catch {
    return plaintext;
  }
}

/**
 * Decrypt a stored secret.
 * Handles three cases: empty, "enc:"-prefixed (encrypted), or legacy plaintext.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext
  const ss = getSafeStorage();
  if (!ss) return stored; // can't decrypt without safeStorage
  try {
    const buf = Buffer.from(stored.slice(4), "base64");
    return ss.decryptString(buf);
  } catch {
    return ""; // corrupted / wrong machine
  }
}

export function isKeychainAvailable(): boolean {
  return getSafeStorage() !== null;
}
