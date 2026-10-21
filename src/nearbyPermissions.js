import { PermissionsAndroid, Platform } from 'react-native';

export async function requestNearbyPermissions() {
  if (Platform.OS !== 'android') {
    return true;
  }

  const version = Number(Platform.Version);

  // Android 12+ (API 31+)
  if (version >= 31) {
    const permissions = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ];

    if (version >= 33) {
      permissions.push(
        PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES
      );
    }

    // Nearby discovery on this device's Google Play services checks both
    // location permissions, including on Android 13+.
    if (version >= 31) {
      permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
    }

    const results = await PermissionsAndroid.requestMultiple(permissions);

    const denied = permissions.filter(
      permission =>
        results[permission] !== PermissionsAndroid.RESULTS.GRANTED
    );

    if (denied.length > 0) {
      console.warn('Nearby permissions denied:', denied);
      return false;
    }

    return true;
  }

  // Android 11 and older
  const permissions = [
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ];

  const results = await PermissionsAndroid.requestMultiple(permissions);

  return permissions.every(
    permission =>
      results[permission] === PermissionsAndroid.RESULTS.GRANTED
  );
}
