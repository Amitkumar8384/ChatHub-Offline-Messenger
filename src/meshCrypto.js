import nacl from 'tweetnacl';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { fromByteArray, toByteArray } from 'base64-js';

// SecureStore key names may only contain letters, numbers, dots, dashes and underscores.
const IDENTITY_STORAGE_KEY = 'chathub.mesh-identity-v1';
const MAX_HOPS = 4;

nacl.setPRNG((target, byteCount) => {
  target.set(Crypto.getRandomBytes(byteCount));
});

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[\da-f]*$/i.test(value)) {
    throw new Error('Invalid key encoding');
  }
  return Uint8Array.from(value.match(/.{2}/g) || [], byte => parseInt(byte, 16));
}

function encodeText(value) {
  const encoded = encodeURIComponent(value);
  const bytes = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return Uint8Array.from(bytes);
}

function decodeText(value) {
  const escaped = Array.from(value, byte => `%${byte.toString(16).padStart(2, '0')}`).join('');
  return decodeURIComponent(escaped);
}

function identityId(signPublicKey) {
  return toHex(nacl.hash(signPublicKey)).slice(0, 64);
}

export async function loadOrCreateMeshIdentity() {
  const saved = await SecureStore.getItemAsync(IDENTITY_STORAGE_KEY);
  let keys;
  if (saved) {
    keys = JSON.parse(saved);
  } else {
    const signing = nacl.sign.keyPair();
    const encryption = nacl.box.keyPair();
    keys = {
      signingPublicKey: toHex(signing.publicKey),
      signingSecretKey: toHex(signing.secretKey),
      encryptionPublicKey: toHex(encryption.publicKey),
      encryptionSecretKey: toHex(encryption.secretKey),
    };
    await SecureStore.setItemAsync(IDENTITY_STORAGE_KEY, JSON.stringify(keys));
  }

  const identity = {
    id: identityId(fromHex(keys.signingPublicKey)),
    signingPublicKey: fromHex(keys.signingPublicKey),
    signingSecretKey: fromHex(keys.signingSecretKey),
    encryptionPublicKey: fromHex(keys.encryptionPublicKey),
    encryptionSecretKey: fromHex(keys.encryptionSecretKey),
  };
  const signingPair = nacl.sign.keyPair.fromSecretKey(identity.signingSecretKey);
  const encryptionPair = nacl.box.keyPair.fromSecretKey(identity.encryptionSecretKey);
  if (identity.signingPublicKey.length !== nacl.sign.publicKeyLength
    || identity.signingSecretKey.length !== nacl.sign.secretKeyLength
    || identity.encryptionPublicKey.length !== nacl.box.publicKeyLength
    || identity.encryptionSecretKey.length !== nacl.box.secretKeyLength
    || toHex(signingPair.publicKey) !== toHex(identity.signingPublicKey)
    || toHex(encryptionPair.publicKey) !== toHex(identity.encryptionPublicKey)) {
    throw new Error('Saved mesh identity is invalid');
  }
  return identity;
}

function signedBytes(value, identity) {
  return fromByteArray(nacl.sign.detached(encodeText(JSON.stringify(value)), identity.signingSecretKey));
}

export function createIdentityAnnouncement(identity, displayName = '', hopsLeft = MAX_HOPS) {
  const announcement = {
    version: 1,
    type: 'mesh-hello',
    senderId: identity.id,
    signingPublicKey: toHex(identity.signingPublicKey),
    encryptionPublicKey: toHex(identity.encryptionPublicKey),
    displayName: String(displayName).slice(0, 100),
  };
  return JSON.stringify({
    ...announcement,
    signature: signedBytes(announcement, identity),
    hopsLeft,
  });
}

export function verifyIdentityAnnouncement(packet) {
  try {
    const signingPublicKey = fromHex(packet.signingPublicKey);
    const encryptionPublicKey = fromHex(packet.encryptionPublicKey);
    const expectedId = identityId(signingPublicKey);
    if (packet.version !== 1 || packet.type !== 'mesh-hello' || packet.senderId !== expectedId
      || encryptionPublicKey.length !== nacl.box.publicKeyLength) return null;
    const announcement = {
      version: packet.version,
      type: packet.type,
      senderId: packet.senderId,
      signingPublicKey: packet.signingPublicKey,
      encryptionPublicKey: packet.encryptionPublicKey,
      displayName: packet.displayName,
    };
    const verified = nacl.sign.detached.verify(
      encodeText(JSON.stringify(announcement)),
      toByteArray(packet.signature),
      signingPublicKey
    );
    if (!verified) return null;
    return {
      id: packet.senderId,
      signingPublicKey: packet.signingPublicKey,
      encryptionPublicKey: packet.encryptionPublicKey,
      name: typeof packet.displayName === 'string' ? packet.displayName : '',
      announcement: JSON.stringify(packet),
    };
  } catch {
    return null;
  }
}

export function verifyMeshEnvelope(packet) {
  try {
    const signingPublicKey = fromHex(packet.signingPublicKey);
    if (packet.version !== 1 || packet.type !== 'mesh-envelope'
      || packet.senderId !== identityId(signingPublicKey)) return null;
    const core = {
      version: packet.version,
      type: packet.type,
      id: packet.id,
      senderId: packet.senderId,
      signingPublicKey: packet.signingPublicKey,
      encryptionPublicKey: packet.encryptionPublicKey,
      recipientId: packet.recipientId,
      sentAt: packet.sentAt,
      kind: packet.kind,
      nonce: packet.nonce,
      ciphertext: packet.ciphertext,
    };
    if (!nacl.sign.detached.verify(
      encodeText(JSON.stringify(core)),
      toByteArray(packet.signature),
      signingPublicKey
    )) return null;
    return {
      id: packet.senderId,
      signingPublicKey: packet.signingPublicKey,
      encryptionPublicKey: packet.encryptionPublicKey,
    };
  } catch {
    return null;
  }
}

export function encryptMeshMessage(identity, recipient, message, kind = 'direct-message') {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const core = {
    version: 1,
    type: 'mesh-envelope',
    id: Crypto.randomUUID(),
    senderId: identity.id,
    signingPublicKey: toHex(identity.signingPublicKey),
    encryptionPublicKey: toHex(identity.encryptionPublicKey),
    recipientId: recipient.id,
    sentAt: Number(message.sentAt) || Date.now(),
    kind,
    nonce: fromByteArray(nonce),
    ciphertext: fromByteArray(nacl.box(
      encodeText(JSON.stringify(message)),
      nonce,
      fromHex(recipient.encryptionPublicKey),
      identity.encryptionSecretKey
    )),
  };
  return JSON.stringify({
    ...core,
    signature: signedBytes(core, identity),
    hopsLeft: MAX_HOPS,
  });
}

export function decryptMeshMessage(packet, sender, identity) {
  try {
    const core = {
      version: packet.version,
      type: packet.type,
      id: packet.id,
      senderId: packet.senderId,
      signingPublicKey: packet.signingPublicKey,
      encryptionPublicKey: packet.encryptionPublicKey,
      recipientId: packet.recipientId,
      sentAt: packet.sentAt,
      kind: packet.kind,
      nonce: packet.nonce,
      ciphertext: packet.ciphertext,
    };
    const senderSigningKey = fromHex(packet.signingPublicKey);
    const senderEncryptionKey = fromHex(packet.encryptionPublicKey);
    if (packet.version !== 1 || packet.type !== 'mesh-envelope'
      || packet.senderId !== sender.id
      || packet.senderId !== identityId(senderSigningKey)
      || !nacl.sign.detached.verify(
        encodeText(JSON.stringify(core)),
        toByteArray(packet.signature),
        senderSigningKey
      )) return null;

    const plaintext = nacl.box.open(
      toByteArray(packet.ciphertext),
      toByteArray(packet.nonce),
      senderEncryptionKey,
      identity.encryptionSecretKey
    );
    return plaintext ? JSON.parse(decodeText(plaintext)) : null;
  } catch {
    return null;
  }
}

export function getMeshPublicKeys(identity) {
  return {
    id: identity.id,
    signingPublicKey: toHex(identity.signingPublicKey),
    encryptionPublicKey: toHex(identity.encryptionPublicKey),
  };
}
