import { NativeEventEmitter, NativeModules } from 'react-native';

const { NearbyConnections } = NativeModules;

if (!NearbyConnections) {
  console.warn(
    'NearbyConnections native module is unavailable. ' +
      'Rebuild the native Android app.'
  );
}

const emitter = NearbyConnections
  ? new NativeEventEmitter(NearbyConnections)
  : null;

function requireNativeModule() {
  if (!NearbyConnections) {
    throw new Error(
      'NearbyConnections native module is unavailable. Rebuild the Android app.'
    );
  }

  return NearbyConnections;
}

export const nearby = {
  isAvailable: () => Boolean(NearbyConnections),

  startDiscovery: () =>
    requireNativeModule().startDiscovery(),

  startAdvertising: (deviceName) =>
    requireNativeModule().startAdvertising(deviceName),

  requestConnection: (endpointId, deviceName) =>
    requireNativeModule().requestConnection(endpointId, deviceName),

  acceptConnection: (endpointId) =>
    requireNativeModule().acceptConnection(endpointId),

  rejectConnection: (endpointId) =>
    requireNativeModule().rejectConnection(endpointId),

  sendMessage: (endpointId, message) =>
    requireNativeModule().sendMessage(endpointId, message),

  sendFile: (endpointId, fileUri, messageId, fileName, mimeType, kind, sentAt, senderName, senderId) =>
    requireNativeModule().sendFile(
      endpointId,
      fileUri,
      messageId,
      fileName,
      mimeType,
      kind,
      sentAt,
      senderName,
      senderId
    ),

  stopDiscovery: () =>
    requireNativeModule().stopDiscovery(),

  stopAdvertising: () =>
    requireNativeModule().stopAdvertising(),

  disconnect: (endpointId) =>
    requireNativeModule().disconnect(endpointId),

  stopAll: () =>
    requireNativeModule().stopAll(),

  // Support both addListener() and on()
  addListener: (eventName, callback) => {
    if (!emitter) {
      console.warn(
        `Cannot subscribe to "${eventName}": native module unavailable.`
      );

      return { remove: () => {} };
    }

    return emitter.addListener(eventName, callback);
  },

  on: (eventName, callback) => {
    if (!emitter) {
      console.warn(
        `Cannot subscribe to "${eventName}": native module unavailable.`
      );

      return () => {};
    }

    const subscription = emitter.addListener(eventName, callback);

    return () => subscription.remove();
  },
};