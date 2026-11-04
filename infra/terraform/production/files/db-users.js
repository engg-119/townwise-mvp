/* global connect, print, process, quit, URL -- mongosh globals; this file runs in mongosh, not Node */
// mongosh script for the caj-townwise-db-users job (jobs.tf), the only job that reads the admin password. Signed
// in as the built-in administrator, it creates, or sets the password of, the users named in the Key Vault
// connection strings, and prints user names and outcomes only:
// - townwise-app (MONGODB_URI) and townwise-backup (MONGODB_BACKUP_URI), always;
// - townwise-restore (MONGODB_RESTORE_URI) only while a restore is under way. When that secret is "none", the
//   job drops the restore user and the townwise_restore database (infra/README.md, step 14).
// Any failure prints only an error name and code: a URI or driver message can carry a password.
//
// DocumentDB native users take cluster-level roles only (learn.microsoft.com/azure/documentdb/secondary-users):
// readAnyDatabase, or readWriteAnyDatabase together with clusterAdmin. A readWrite role on one database is
// rejected (RoleNotFound). The cluster holds only Townwise data, so a writer's reach is that data.
// Errors this script raises; only their messages are printed (they never include a value).
class SetupError extends Error {}

const readWrite = [{ role: 'readWriteAnyDatabase', db: 'admin' }, { role: 'clusterAdmin', db: 'admin' }];
const users = {
  app: { variable: 'MONGODB_URI', user: 'townwise-app', roles: readWrite },
  backup: { variable: 'MONGODB_BACKUP_URI', user: 'townwise-backup', roles: [{ role: 'readAnyDatabase', db: 'admin' }] },
  restore: { variable: 'MONGODB_RESTORE_URI', user: 'townwise-restore', roles: readWrite },
};

function parse(spec) {
  const value = process.env[spec.variable];
  if (!value) throw new SetupError(`${spec.variable} is not set`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError(`${spec.variable} is not a valid URI`);
  }
  // Private endpoints need mongodb+srv (learn.microsoft.com/azure/documentdb/how-to-private-link).
  if (url.protocol !== 'mongodb+srv:' || url.hostname === '') throw new SetupError(`${spec.variable} must be a mongodb+srv:// URI with a host`);
  if (decodeURIComponent(url.username) !== spec.user) throw new SetupError(`${spec.variable} must name the user ${spec.user}`);
  const pwd = decodeURIComponent(url.password);
  if (pwd.length < 32) throw new SetupError(`${spec.variable} needs a password of at least 32 characters`);
  if (url.pathname !== '/townwise') throw new SetupError(`${spec.variable} must name the townwise database`);
  const required = { tls: 'true', authMechanism: 'SCRAM-SHA-256', retrywrites: 'false', maxIdleTimeMS: '120000' };
  for (const [key, expected] of Object.entries(required)) {
    if (url.searchParams.get(key) !== expected) throw new SetupError(`${spec.variable} must set ${key}=${expected}`);
  }
  return { url, pwd };
}

const sameRoles = (a, b) => JSON.stringify(a.map((r) => `${r.db}.${r.role}`).sort()) === JSON.stringify(b.map((r) => `${r.db}.${r.role}`).sort());

try {
  const app = parse(users.app);
  const backup = parse(users.backup);
  const restoring = process.env.MONGODB_RESTORE_URI !== 'none';
  const restore = restoring ? parse(users.restore) : null;
  for (const other of [backup, restore]) {
    if (other !== null && other.url.host !== app.url.host) throw new SetupError('every URI must name the same cluster');
  }

  const adminUrl = new URL(app.url.toString());
  adminUrl.username = process.env.DB_ADMIN_USER;
  adminUrl.password = process.env.DB_ADMIN_PASSWORD;
  adminUrl.pathname = '/';
  const admin = connect(adminUrl.toString()).getSiblingDB('admin');
  const existing = (name) => admin.runCommand({ usersInfo: name }).users ?? []; // DocumentDB omits users when none match

  const wanted = [['app', app], ['backup', backup]];
  if (restore !== null) wanted.push(['restore', restore]);
  for (const [label, parsed] of wanted) {
    const spec = users[label];
    const found = existing(spec.user);
    if (found.length === 0) {
      admin.runCommand({ createUser: spec.user, pwd: parsed.pwd, roles: spec.roles });
      print(`${label}: created ${spec.user}`);
      continue;
    }
    // updateUser changes only the password on DocumentDB; wrong roles need dropUser, then a rerun.
    if (!sameRoles(found[0].roles, spec.roles)) throw new SetupError(`${spec.user} has unexpected roles; drop it and rerun`);
    admin.runCommand({ updateUser: spec.user, pwd: parsed.pwd });
    print(`${label}: set the password of ${spec.user}`);
  }

  if (restore === null) {
    if (existing(users.restore.user).length > 0) {
      admin.runCommand({ dropUser: users.restore.user });
      print(`restore: dropped ${users.restore.user}`);
    }
    admin.getSiblingDB('townwise_restore').dropDatabase();
    print('restore: no townwise_restore database');
  }
} catch (err) {
  if (err instanceof SetupError) {
    print(`db-users failed: ${err.message}`);
  } else {
    const code = err !== null && typeof err === 'object' && 'code' in err ? ` (code ${String(err.code)})` : '';
    print(`db-users failed: ${err instanceof Error ? err.name : 'error'}${code}`);
  }
  quit(1);
}
