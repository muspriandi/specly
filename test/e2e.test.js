// End-to-end tests. The harness (database, app, HTTP client) lives in support.js and the tests in suites/.
// Suites share one database and run in this order: later ones build on the accounts and blueprints earlier ones create.
require('./support');
require('./suites/01-security-and-login');
require('./suites/02-invites-and-requests');
require('./suites/03-blueprints-and-versions');
require('./suites/04-credentials-and-audit');
require('./suites/05-search-and-previews');
require('./suites/06-access-management');
require('./suites/07-invitations-edit-and-ops');
require('./suites/08-sharing-and-account-security');
require('./suites/09-manage-lists-and-trash');
require('./suites/10-logging');
