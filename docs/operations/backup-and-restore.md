# Backup and restore

The database holds accounts, organisations, sessions, model credentials,
integration links, projects and work items. Losing it means re-doing every step
in [`docs/setup/`](../setup/).

## Taking a snapshot

```bash
npm run db:backup
```

Writes a timestamped `.db` file to `~/.samskara-backups` and keeps the ten most
recent. Change the count with `--keep`:

```bash
node scripts/backup-db.mjs --keep 30
```

It uses `VACUUM INTO` rather than copying the file. SQLite parks recent writes
in a `-wal` sidecar until a checkpoint, so copying `samskara.db` alone can miss
them; `VACUUM INTO` writes a consistent, checkpointed copy. It also refuses to
overwrite, so a name collision is a real collision rather than silent data loss.

**Snapshot before stopping the server**, particularly before killing the
process. A hard kill leaves whatever is in the WAL uncommitted.

## Restoring

Stop the server first. Restoring under a running server corrupts both copies.

```bash
# 1. stop the server, then confirm nothing holds the database
#    Windows:  Get-NetTCPConnection -LocalPort 4111 -State Listen
#    macOS/Linux: lsof -i :4111

# 2. move the current files aside rather than deleting them
mv data/samskara.db      data/samskara.db.old
mv data/samskara.db-wal  data/samskara.db-wal.old   2>/dev/null
mv data/samskara.db-shm  data/samskara.db-shm.old   2>/dev/null

# 3. put the snapshot in place
cp ~/.samskara-backups/samskara-<timestamp>.db data/samskara.db

# 4. start the server
npm run dev:secure
```

Move the `-wal` and `-shm` sidecars too. Leaving a stale WAL beside a restored
database can replay writes the snapshot does not expect.

The snapshot is already checkpointed, so it arrives without sidecars. SQLite
creates new ones.

### Confirming the restore

```bash
node -e "
const url='file:'+process.cwd().replace(/\\\\/g,'/')+'/data/samskara.db';
(async()=>{const {createClient}=await import('@libsql/client');const c=createClient({url});
for (const t of ['user','organization','factory_projects','work_items']) {
  const r=await c.execute('select count(*) as n from '+t);
  console.log(t.padEnd(20), r.rows[0].n);
}})();"
```

Then sign in. If the accounts are there, the restore worked.

## What a snapshot does not cover

- **`.env` and your secret manager.** Credentials live outside the database.
  `FACTORY_CREDENTIAL_ENCRYPTION_KEY` in particular: stored provider credentials
  are encrypted with it, so a database restored without the matching key has
  credential rows that cannot be read.
- **The vector database.** `samskara-vectors.db` is a separate file and this
  script does not snapshot it. It holds embeddings, which can be rebuilt.
- **Turso.** With `TURSO_DATABASE_URL` set, the server is not using the local
  file at all. This script only reads `MASTRA_DB_PATH` and fails if it is unset,
  so it never touches a hosted database. Use [Turso's own backup
  tooling](https://docs.turso.tech/features/point-in-time-recovery) instead.

## Where backups live

`~/.samskara-backups`, deliberately outside the repository. `mastra build`
deletes the whole `.mastra/` directory, and an earlier layout that kept the
database and its backups in there lost both.
