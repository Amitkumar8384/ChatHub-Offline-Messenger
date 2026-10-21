const fs = require('node:fs/promises');
const path = require('node:path');
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
} = require('expo/config-plugins');

const ANDROID_PACKAGE = 'com.chathub.offline';
const NATIVE_FILES = [
  'NearbyConnectionsModule.kt',
  'NearbyConnectionsPackage.kt',
];

function withNearbyManifestPermissions(config) {
  return withAndroidManifest(config, modConfig => {
    const manifest = modConfig.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];
    const versionLimits = {
      'android.permission.BLUETOOTH': { maxSdkVersion: '30' },
      'android.permission.BLUETOOTH_ADMIN': { maxSdkVersion: '30' },
      'android.permission.BLUETOOTH_ADVERTISE': { minSdkVersion: '31' },
      'android.permission.BLUETOOTH_CONNECT': { minSdkVersion: '31' },
      'android.permission.BLUETOOTH_SCAN': { minSdkVersion: '31' },
      'android.permission.NEARBY_WIFI_DEVICES': { minSdkVersion: '32' },
    };

    for (const [permission, limits] of Object.entries(versionLimits)) {
      let entry = permissions.find(item => item.$?.['android:name'] === permission);
      if (!entry) {
        entry = { $: { 'android:name': permission } };
        permissions.push(entry);
      }
      Object.entries(limits).forEach(([key, value]) => {
        entry.$[`android:${key}`] = value;
      });
    }

    let coarseLocationPermission = permissions.find(
      item => item.$?.['android:name'] === 'android.permission.ACCESS_COARSE_LOCATION'
    );
    if (!coarseLocationPermission) {
      coarseLocationPermission = { $: { 'android:name': 'android.permission.ACCESS_COARSE_LOCATION' } };
      permissions.push(coarseLocationPermission);
    }
    delete coarseLocationPermission.$['android:maxSdkVersion'];

    let fineLocationPermission = permissions.find(
      item => item.$?.['android:name'] === 'android.permission.ACCESS_FINE_LOCATION'
    );
    if (!fineLocationPermission) {
      fineLocationPermission = { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } };
      permissions.push(fineLocationPermission);
    }
    delete fineLocationPermission.$['android:maxSdkVersion'];

    let wifiStatePermission = permissions.find(
      item => item.$?.['android:name'] === 'android.permission.ACCESS_WIFI_STATE'
    );
    if (!wifiStatePermission) {
      wifiStatePermission = { $: { 'android:name': 'android.permission.ACCESS_WIFI_STATE' } };
      permissions.push(wifiStatePermission);
    }
    delete wifiStatePermission.$['android:maxSdkVersion'];

    let changeWifiStatePermission = permissions.find(
      item => item.$?.['android:name'] === 'android.permission.CHANGE_WIFI_STATE'
    );
    if (!changeWifiStatePermission) {
      changeWifiStatePermission = { $: { 'android:name': 'android.permission.CHANGE_WIFI_STATE' } };
      permissions.push(changeWifiStatePermission);
    }
    delete changeWifiStatePermission.$['android:maxSdkVersion'];

    manifest['uses-permission'] = permissions;
    return modConfig;
  });
}

function withNearbyGradleDependency(config) {
  return withAppBuildGradle(config, modConfig => {
    const dependency = 'implementation("com.google.android.gms:play-services-nearby:19.3.0")';
    let contents = modConfig.modResults.contents;
    if (!contents.includes('play-services-nearby')) {
      if (!/dependencies\s*\{/.test(contents)) {
        throw new Error('Could not find the Android dependencies block for Nearby Connections.');
      }
      contents = contents.replace(/dependencies\s*\{/, match => `${match}\n    ${dependency}`);
    }
    modConfig.modResults.contents = contents;
    return modConfig;
  });
}

function withNearbyPackageRegistration(config) {
  return withMainApplication(config, modConfig => {
    let contents = modConfig.modResults.contents;
    if (!contents.includes('NearbyConnectionsPackage')) {
      const packageMatch = contents.match(/^package\s+[\w.]+\s*$/m);
      if (!packageMatch) {
        throw new Error('Could not find the Kotlin package declaration in MainApplication.');
      }
      const appPackage = packageMatch[0].replace(/^package\s+/, '').trim();
      if (appPackage !== ANDROID_PACKAGE) {
        throw new Error(`Nearby Connections currently requires Android package ${ANDROID_PACKAGE}.`);
      }

      contents = contents.replace(packageMatch[0], `${packageMatch[0]}\n\nimport ${ANDROID_PACKAGE}.NearbyConnectionsPackage`);
      const packageListApply = /PackageList\(this\)\.packages\.apply\s*\{/;
      if (packageListApply.test(contents)) {
        contents = contents.replace(packageListApply, match => `${match}\n          add(NearbyConnectionsPackage())`);
      } else {
        const packageList = 'PackageList(this).packages';
        if (!contents.includes(packageList)) {
          throw new Error('Could not find PackageList(this).packages in MainApplication.');
        }
        contents = contents.replace(packageList, `${packageList}.apply { add(NearbyConnectionsPackage()) }`);
      }
      modConfig.modResults.contents = contents;
    }
    return modConfig;
  });
}

function withNearbyNativeSources(config) {
  return withDangerousMod(config, [
    'android',
    async modConfig => {
      const sourceDirectory = path.join(__dirname, 'nearby-android');
      const targetDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        ...ANDROID_PACKAGE.split('.')
      );
      await fs.mkdir(targetDirectory, { recursive: true });
      await Promise.all(NATIVE_FILES.map(file =>
        fs.copyFile(path.join(sourceDirectory, file), path.join(targetDirectory, file))
      ));
      return modConfig;
    },
  ]);
}

module.exports = function withNearbyConnections(config) {
  if (config.android?.package !== ANDROID_PACKAGE) {
    throw new Error(`Nearby Connections requires expo.android.package to be ${ANDROID_PACKAGE}.`);
  }
  config = withNearbyManifestPermissions(config);
  config = withNearbyGradleDependency(config);
  config = withNearbyPackageRegistration(config);
  config = withNearbyNativeSources(config);
  return config;
};
