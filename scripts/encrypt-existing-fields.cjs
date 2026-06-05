'use strict';

// One-shot migration: re-write every invite through the encrypted-aware
// storage layer so all PII fields end up encrypted and indexed.
//
// Safe to re-run -- entityToInvite already decrypts encrypted rows, and
// inviteToEntity always re-emits ciphertext under the CURRENT key. The
// only side effect of re-running is bumping `updatedAt` and rotating the
// ciphertext under the latest key version (which is also the re-encryption
// half of a key rotation).
//
// Usage:
//   $env:RSVP_STORAGE_CONNECTION = "<account connection string>"
//   $env:RSVP_FIELD_KEY_CURRENT  = "<base64 32 bytes>"
//   $env:RSVP_FIELD_KEY_PREVIOUS = "<base64 32 bytes>"  # optional, only set during rotation
//   $env:RSVP_BLIND_INDEX_KEY    = "<base64 32 bytes>"
//   node scripts/encrypt-existing-fields.cjs [--dry-run] [--verbose]
//
// Exits non-zero on any per-row failure so a scheduled rotation Action
// catches partial sweeps and pages someone.

const path = require('path');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const verbose = args.has('--verbose');

for (const k of ['RSVP_STORAGE_CONNECTION', 'RSVP_FIELD_KEY_CURRENT', 'RSVP_BLIND_INDEX_KEY']) {
  if (!process.env[k]) {
    console.error(`ERROR: ${k} env var is required`);
    process.exit(2);
  }
}

const storage = require(path.resolve(__dirname, '..', 'api', '_lib', 'storage.js'));
const fc = require(path.resolve(__dirname, '..', 'api', '_lib', 'fieldcrypto.js'));

(async () => {
  console.log(`encrypt-existing-fields (${dryRun ? 'DRY RUN' : 'LIVE'})`);
  console.log('----------------------------------');

  const invites = await storage.listInvites();
  console.log(`Loaded ${invites.length} invites from storage`);

  const stats = { encrypted: 0, already: 0, errors: 0, skipped: 0 };

  for (const inv of invites) {
    try {
      // Re-fetch the raw entity so we can see whether it's already encrypted
      // (`listInvites` gives us decrypted plaintext, which loses that signal).
      const clients = storage.getClients();
      const raw = await clients.invites.getEntity('invites', inv.inviteId);

      const wasFirstEnc = fc.isEncrypted(raw.primaryFirstName || '');
      const wasLastEnc = fc.isEncrypted(raw.primaryLastName || '');
      const wasPhoneEnc = fc.isEncrypted(raw.phone || '');
      const hadIndex = !!(raw.primaryFirstIndex && raw.primaryLastIndex && raw.phoneIndex);

      const fullyEncrypted = wasFirstEnc && wasLastEnc && wasPhoneEnc && hadIndex;
      if (fullyEncrypted) {
        // Still re-write so the row picks up the latest CURRENT key (this is
        // the rotation-sweep behavior). Skip only if explicitly dry-run.
        if (verbose) console.log(`  ROTATE  ${inv.inviteId}  (already encrypted; re-emitting under CURRENT)`);
      } else {
        if (verbose) console.log(`  ENCRYPT ${inv.inviteId}  (first=${wasFirstEnc ? 'enc' : 'legacy'}, last=${wasLastEnc ? 'enc' : 'legacy'}, phone=${wasPhoneEnc ? 'enc' : 'legacy'}, index=${hadIndex ? 'yes' : 'no'})`);
      }

      if (dryRun) {
        if (fullyEncrypted) stats.already += 1;
        else stats.encrypted += 1;
        continue;
      }

      // upsertInvite calls inviteToEntity which re-encrypts every PII field
      // under the CURRENT key + recomputes blind indexes + clears legacy
      // norms. That's exactly the behavior we want for both initial
      // migration and rotation sweep.
      await storage.upsertInvite(inv);

      if (fullyEncrypted) stats.already += 1;
      else stats.encrypted += 1;
    } catch (err) {
      stats.errors += 1;
      console.error(`  ERROR   ${inv.inviteId}  ${err.message}`);
    }
  }

  console.log('----------------------------------');
  console.log(`Newly encrypted / re-keyed: ${stats.encrypted}`);
  console.log(`Already encrypted (rotated under CURRENT): ${stats.already}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Total scanned: ${invites.length}`);

  if (stats.errors > 0) process.exit(1);

  if (!dryRun) {
    // Best-effort audit event so the admin "Recent activity" panel shows the
    // sweep happened (helps post-incident reconstruction).
    try {
      await storage.appendEvent({
        type: 'admin.encrypt_sweep',
        actor: process.env.GITHUB_ACTOR || 'manual',
        summary: `Re-encrypted ${stats.encrypted + stats.already} invite rows under current field key`,
        meta: { encrypted: stats.encrypted, already: stats.already }
      });
    } catch (err) {
      console.warn(`(non-fatal) failed to append audit event: ${err.message}`);
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
