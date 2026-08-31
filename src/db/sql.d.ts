/**
 * `.sql` migration files are turned into string literals at build time by
 * `babel-plugin-inline-import` (see `babel.config.js`), so an import of a
 * `.sql` file yields the file's contents as a string.
 *
 * Ambient declaration — this file must stay free of top-level imports/exports.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
