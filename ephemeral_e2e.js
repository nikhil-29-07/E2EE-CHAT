// src/crypto/ephemeral_e2e.js
// Uses libsodium-wrappers sealed-box API for true E2EE.
// Exports: generateEphemeralKeyPair(), encryptForRecipient(), decryptForMe()

import sodium from "libsodium-wrappers";

/**
 * generateEphemeralKeyPair
 * returns { publicKey: base64, privateKey: base64 }
 */
export async function generateEphemeralKeyPair() {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey),
    privateKey: sodium.to_base64(kp.privateKey),
  };
}

/**
 * encryptForRecipient(plaintext, recipientPublicKeyBase64)
 * returns base64 ciphertext (sealed-box)
 */
export async function encryptForRecipient(plaintext, recipientPublicKeyBase64) {
  await sodium.ready;
  const pub = sodium.from_base64(recipientPublicKeyBase64);
  // crypto_box_seal expects Uint8Array plaintext
  const pt = new TextEncoder().encode(String(plaintext));
  const ct = sodium.crypto_box_seal(pt, pub);
  return sodium.to_base64(ct);
}

/**
 * decryptForMe(ciphertextBase64, myPublicKeyBase64, myPrivateKeyBase64)
 * returns plaintext string or throws
 */
export async function decryptForMe(ciphertextBase64, myPublicKeyBase64, myPrivateKeyBase64) {
  await sodium.ready;
  if (!ciphertextBase64) return "";
  const ct = sodium.from_base64(ciphertextBase64);
  const pub = sodium.from_base64(myPublicKeyBase64);
  const priv = sodium.from_base64(myPrivateKeyBase64);
  try {
    const pt = sodium.crypto_box_seal_open(ct, pub, priv);
    return new TextDecoder().decode(pt);
  } catch (e) {
    // not encrypted for this keypair or decryption failed
    throw new Error("Decryption failed");
  }
}
