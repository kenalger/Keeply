/**
 * Keeply — Babel config.
 *
 * `inline-import` replaces `import m0000 from './0000_x.sql'` in
 * `drizzle/migrations.js` with the file's contents as a string literal, which
 * is how drizzle-kit's `driver: 'expo'` bundle is meant to be consumed. Without
 * it, Metro cannot resolve the `.sql` import and migrations never load.
 */
module.exports = function babelConfig(api) {
  api.cache(true);

  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
