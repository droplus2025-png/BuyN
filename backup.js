// Backup file: the WHOLE database as one JSON file (export), and a verified restore (import).
// A file is checked (format, owner present, every invoice / stock / debt figure re-verified)
// BEFORE it replaces anything, so a damaged or edited file can never corrupt the program.
import { createMemoryStore, TABLES } from './memory-store.js';
import { integrityProblems } from './queries.js';
import { fail } from './errors.js';

const BACKUP_FORMAT = 'pos-backup';
const BACKUP_VERSION = 1;

export function buildBackup(store, meta = {}) {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: new Date().toISOString(), ...meta, state: store.export() };
}

export async function verifyBackup(file) {
  if (!file || file.format !== BACKUP_FORMAT) fail('BAD_BACKUP', 'This is not a backup file of the program');
  if (!(file.version <= BACKUP_VERSION)) fail('BAD_BACKUP', 'This backup comes from a newer version of the program');
  const st = file.state;
  if (!st || typeof st !== 'object') fail('BAD_BACKUP', 'The backup has no data');
  for (const t of TABLES) if (st[t] !== undefined && !Array.isArray(st[t])) fail('BAD_BACKUP', `Table ${t} is damaged`);
  if (!(st.app_users || []).some((u) => u.role === 'owner')) fail('BAD_BACKUP', 'The backup has no owner account');
  const problems = await createMemoryStore(st).transaction((tx) => integrityProblems(tx));
  const count = (t) => (st[t] || []).length;
  return { ok: problems.length === 0, problems, counts: { products: count('products'), invoices: count('invoices'), customers: count('customers'), suppliers: count('suppliers') },
    exported_at: file.exported_at };
}
