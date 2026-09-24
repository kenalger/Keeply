/**
 * Keeply — strip the remote-push entitlement.
 *
 * `expo-notifications` is auto-applied by prebuild whether or not it is listed
 * in `app.json` → `plugins`: it is in `versionedExpoSDKPackages`
 * (node_modules/@expo/prebuild-config/build/plugins/withDefaultPlugins.js:171),
 * and its iOS half unconditionally writes
 * `aps-environment = development` into the entitlements
 * (node_modules/expo-notifications/plugin/build/withNotificationsIOS.js:11-14).
 *
 * Keeply has no backend and no push server (see CLAUDE.md, goal.md §19). It
 * schedules LOCAL notifications only, which need no entitlement at all. An
 * unused `aps-environment` entitlement is a capability the app does not need,
 * and it makes App Store upload fail unless the App ID also carries the Push
 * Notifications capability. So we remove it after the auto-applied plugin runs.
 *
 * `NotificationsAppDelegateSubscriber` (expo-notifications/ios) only *responds*
 * to APNs callbacks; it never calls `registerForRemoteNotifications`, so
 * removing the entitlement changes no runtime behavior.
 *
 * ORDER MATTERS. `app.json` lists `expo-notifications` explicitly (for the
 * Android notification icon and colour), and it must come AFTER this plugin:
 * mods run in reverse registration order, so a later entry's entitlement write
 * runs first and this delete runs last. Listed before it, `aps-environment`
 * reappears. Check `ios/Keeply/Keeply.entitlements` after any reorder.
 *
 * If push is ever added, delete this plugin rather than working around it.
 */
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withLocalOnlyNotifications(config) {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults['aps-environment'];
    return config;
  });
};
