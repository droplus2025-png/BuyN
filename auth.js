// Access code -> role (automatic). Simple, local, works offline.
// The code is never stored: only SHA-256(salt + code). Owner manages employees and permissions.
import { fail } from './errors.js';
import { createAccess, isPermissionKey, CATALOG } from './permissions.js';

const enc = new TextEncoder();
async function sha256(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const getSalt = async (tx, ctx, create) => {
  let s = await tx.get('settings', 'code_salt');
  if (!s && create) s = await tx.insert('settings', { key: 'code_salt', value: ctx.ids(), updated_at: ctx.now().toISOString() });
  if (!s) fail('NOT_SETUP', 'The program has no owner yet');
  return s.value;
};
const checkCode = (code) => { if (!/^.{4,}$/.test(String(code ?? ''))) fail('WEAK_CODE', 'The access code needs at least 4 characters'); };

export function createAuth({ store, now = () => new Date(), ids = () => globalThis.crypto.randomUUID() }) {
  const ctx = { now, ids };

  async function loadDefaults(tx) {
    const s = await tx.get('settings', 'permission_defaults');
    return s?.value || {};
  }
  async function sessionOf(tx, user) {
    const defaults = await loadDefaults(tx);
    const access = createAccess({ role: user.role, perms: user.perms || {}, defaults });
    return { userId: user.id, name: user.name, role: user.role, access, permissions: access.all() };
  }
  async function uniqueHash(tx, code, salt, exceptId) {
    const h = await sha256(salt + code);
    const dup = (await tx.find('app_users', u => u.code_hash === h && u.id !== exceptId))[0];
    if (dup) fail('CODE_TAKEN', 'This access code is already used');
    return h;
  }

  return {
    async hasOwner() { return store.transaction(async (tx) => (await tx.find('app_users', u => u.role === 'owner')).length > 0); },
    // first launch: the first account is the owner
    async setupOwner({ name, code }) {
      checkCode(code);
      return store.transaction(async (tx) => {
        if ((await tx.find('app_users', u => u.role === 'owner')).length) fail('ALREADY_SETUP', 'An owner already exists');
        const salt = await getSalt(tx, ctx, true);
        const user = await tx.insert('app_users', { id: ids(), name: name || 'المالك', role: 'owner',
          code_hash: await uniqueHash(tx, code, salt), active: true, perms: {}, created_at: now().toISOString(), updated_at: now().toISOString() });
        return sessionOf(tx, user);
      });
    },
    // the code identifies the role: no "I am the owner" choice
    async login(code) {
      return store.transaction(async (tx) => {
        const salt = await getSalt(tx, ctx, false);
        const h = await sha256(salt + String(code ?? ''));
        const user = (await tx.find('app_users', u => u.code_hash === h && u.active))[0];
        if (!user) fail('BAD_CODE', 'Wrong access code');
        return sessionOf(tx, user);
      });
    },
    async addEmployee(session, { name, code }) {
      session.access.requireOwner(); checkCode(code);
      return store.transaction(async (tx) => {
        const salt = await getSalt(tx, ctx, false);
        const user = await tx.insert('app_users', { id: ids(), name, role: 'employee',
          code_hash: await uniqueHash(tx, code, salt), active: true, perms: {}, created_at: now().toISOString(), updated_at: now().toISOString() });
        return { id: user.id, name: user.name };
      });
    },
    async changeCode(session, userId, newCode) {
      session.access.requireOwner(); checkCode(newCode);
      return store.transaction(async (tx) => {
        const salt = await getSalt(tx, ctx, false);
        await tx.update('app_users', userId, { code_hash: await uniqueHash(tx, newCode, salt, userId), updated_at: now().toISOString() });
      });
    },
    async setEmployeeActive(session, userId, active) {
      session.access.requireOwner();
      return store.transaction(async (tx) => {
        const u = await tx.get('app_users', userId);
        if (!u || u.role !== 'employee') fail('NOT_EMPLOYEE', 'Not an employee account');
        await tx.update('app_users', userId, { active: !!active, updated_at: now().toISOString() });
      });
    },

    // ----- Settings screen: permissions chosen by the owner
    async setUserPermission(session, userId, key, allowed) {
      session.access.requireOwner();
      if (!isPermissionKey(key)) fail('UNKNOWN_PERMISSION', `Unknown permission ${key}`);
      return store.transaction(async (tx) => {
        const u = await tx.get('app_users', userId);
        if (!u || u.role !== 'employee') fail('NOT_EMPLOYEE', 'Not an employee account');
        await tx.update('app_users', userId, { perms: { ...u.perms, [key]: !!allowed }, updated_at: now().toISOString() });
      });
    },
    async resetUserPermissions(session, userId, key = null) {
      session.access.requireOwner();
      return store.transaction(async (tx) => {
        const u = await tx.get('app_users', userId);
        if (!u || u.role !== 'employee') fail('NOT_EMPLOYEE', 'Not an employee account');
        const perms = { ...u.perms };
        if (key) delete perms[key]; else for (const k of Object.keys(perms)) delete perms[k];
        await tx.update('app_users', userId, { perms, updated_at: now().toISOString() });
      });
    },
    async setDefaultPermission(session, key, allowed) {
      session.access.requireOwner();
      if (!isPermissionKey(key)) fail('UNKNOWN_PERMISSION', `Unknown permission ${key}`);
      return store.transaction(async (tx) => {
        const cur = await tx.get('settings', 'permission_defaults');
        const value = { ...(cur?.value || {}), [key]: !!allowed };
        if (cur) await tx.update('settings', 'permission_defaults', { value, updated_at: now().toISOString() });
        else await tx.insert('settings', { key: 'permission_defaults', value, updated_at: now().toISOString() });
      });
    },
    async listEmployees(session) {
      session.access.requireOwner();
      return store.transaction(async (tx) => (await tx.find('app_users', u => u.role === 'employee')).map(u => ({ id: u.id, name: u.name, active: u.active })));
    },
    // rows for the Settings screen: one per employee x permission
    async listPermissions(session) {
      session.access.requireOwner();
      return store.transaction(async (tx) => {
        const defaults = await loadDefaults(tx);
        const users = await tx.find('app_users', u => u.role === 'employee');
        return users.flatMap(u => CATALOG.map(p => {
          const custom = typeof u.perms?.[p.key] === 'boolean';
          const dflt = p.key in defaults ? defaults[p.key] : p.default_employee;
          return { user_id: u.id, user_name: u.name, key: p.key, grp: p.grp, label_ar: p.label_ar, sort: p.sort,
            enforced_by_db: p.enforced_by_db, allowed: custom ? u.perms[p.key] : dflt, customized: custom };
        }));
      });
    },
  };
}
