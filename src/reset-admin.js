/*
 * Allokis: admin password reset (command-line fallback).
 * Copyright (C) 2026 Ultra Pest Control.  Licensed under the GNU AGPL v3.
 *
 * Use this when you're locked out of the admin console entirely and don't have
 * a recovery code. Because it needs shell access to the server, only someone
 * who controls the machine can run it, which is the right bar for a last-resort
 * reset.
 *
 * Usage:
 *   node src/reset-admin.js "NewStrongPassword"          (resets the first admin)
 *   node src/reset-admin.js "NewStrongPassword" "Admin"  (resets a named admin)
 *
 * With Docker:
 *   docker compose exec stocktrax node src/reset-admin.js "NewStrongPassword"
 *
 * It sets the new password, prints a fresh recovery code, and signs out all
 * existing sessions for that account.
 */
'use strict';

const db = require('./db');
const { hashPassword, generateRecoveryCode } = require('./auth');

const newPassword = process.argv[2];
const targetName = process.argv[3];

if (!newPassword || newPassword.length < 8) {
  console.error('Error: provide a new password of at least 8 characters.');
  console.error('Usage: node src/reset-admin.js "NewStrongPassword" ["Admin Name"]');
  process.exit(1);
}

const admin = targetName
  ? db.prepare("SELECT * FROM users WHERE name = ? AND role = 'admin'").get(targetName)
  : db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();

if (!admin) {
  console.error(targetName ? `No admin named "${targetName}" found.` : 'No admin account found.');
  process.exit(1);
}

const recoveryCode = generateRecoveryCode();
db.prepare('UPDATE users SET password_hash = ?, recovery_hash = ? WHERE id = ?')
  .run(hashPassword(newPassword), hashPassword(recoveryCode), admin.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);

console.log('');
console.log(`  Password reset for admin: ${admin.name}`);
console.log(`  New recovery code (save this): ${recoveryCode}`);
console.log('  All existing sessions for this account were signed out.');
console.log('');
process.exit(0);
