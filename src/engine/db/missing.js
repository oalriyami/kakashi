/**
 * The error for a database driver that is not installed (#46).
 *
 * The drivers are optional peer dependencies: `npm install -g
 * @muhammadatef/kakashi` no longer pulls ~400 packages (205 MB) for six
 * databases most people never use. A globally installed Kakashi finds a driver
 * installed globally next to it, or one in the project it runs from.
 *
 * @param {string} name - the database, for the message
 * @param {string} pkg - the npm package
 * @param {string} [note] - e.g. the Node version it needs
 */
function missingDriver(name, pkg, note = '') {
  return new Error(
    `The ${name} driver is not installed. Install it next to Kakashi: npm install -g ${pkg}`
    + ` (or npm install ${pkg} in your project)${note ? `. ${note}` : ''}.`,
  );
}

module.exports = { missingDriver };
