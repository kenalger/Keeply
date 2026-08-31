/**
 * Keeply — Metro config.
 *
 * `sql` is added to `sourceExts` so Metro treats drizzle-kit's generated
 * migration files as source. `babel-plugin-inline-import` (see
 * `babel.config.js`) inlines their contents as strings before Metro resolves
 * the import; this entry keeps the pipeline honest if that ever changes.
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push('sql');

module.exports = config;
