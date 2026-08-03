#!/usr/bin/env node
/*
 * backfill-snapshots.js: one-off recovery of historic register snapshots.
 *
 * Walks the git history of data/*.json and reconstructs a dated snapshot for
 * every commit that changed a register. This recovers whatever real history
 * the repository already holds; it cannot invent history that was never
 * committed, so the resulting series is the honest start of the archive.
 *
 * Safe to re-run: existing snapshot directories are left untouched unless
 * --force is passed. Nothing outside data/snapshots/ is written.
 *
 * Usage:
 *   node scripts/backfill-snapshots.js [--dry-run] [--force]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');

// Registers to archive: source file -> name inside the dated folder.
const REGISTERS = {
    'data/casps.json': 'casps.json',
    'data/emts.json': 'emts.json',
    'data/non-compliant.json': 'non-compliant.json'
};

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');

function git(...gitArgs) {
    return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// File content at a commit, or null when the file did not exist yet.
function fileAtCommit(commit, filePath) {
    try {
        return git('show', `${commit}:${filePath}`);
    } catch (error) {
        return null;
    }
}

function parseJsonOrNull(raw, label) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        console.warn(`   ⚠️ ${label}: unparseable JSON, skipped`);
        return null;
    }
}

function collectCommits() {
    // Oldest first, so later commits on the same date overwrite earlier ones
    // and each date ends up holding that day's final state.
    const out = git('log', '--reverse', '--format=%H|%ad', '--date=short', '--', ...Object.keys(REGISTERS));
    return out.split('\n').filter(Boolean).map(line => {
        const [hash, date] = line.split('|');
        return { hash, date };
    });
}

function main() {
    console.log('🕰️  Backfilling register snapshots from git history...');
    if (DRY_RUN) console.log('   (dry run, nothing will be written)');

    const commits = collectCommits();
    if (commits.length === 0) {
        console.log('   No commits touching the register files. Nothing to backfill.');
        return;
    }
    console.log(`   ${commits.length} commit(s) touch the registers.`);

    const written = new Map(); // date -> counts

    for (const { hash, date } of commits) {
        const payload = {};
        for (const [sourcePath, outputName] of Object.entries(REGISTERS)) {
            const rows = parseJsonOrNull(fileAtCommit(hash, sourcePath), `${date} ${sourcePath}`);
            if (rows) payload[outputName] = rows;
        }
        if (Object.keys(payload).length === 0) continue;

        const dir = path.join(SNAPSHOTS_DIR, date);
        if (!FORCE && fs.existsSync(dir) && !written.has(date)) {
            console.log(`   ${date}: already present, skipping (use --force to overwrite)`);
            continue;
        }

        if (!DRY_RUN) {
            fs.mkdirSync(dir, { recursive: true });
            for (const [name, rows] of Object.entries(payload)) {
                fs.writeFileSync(path.join(dir, name), JSON.stringify(rows, null, 2));
            }
        }
        written.set(date, Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length])));
    }

    console.log(`\n📦 Reconstructed ${written.size} dated snapshot(s):`);
    [...written.entries()].sort().forEach(([date, counts]) => {
        const summary = Object.entries(counts).map(([f, n]) => `${f.replace('.json', '')}=${n}`).join(', ');
        console.log(`   ${date}  ${summary}`);
    });

    if (!DRY_RUN && written.size > 0) {
        console.log('\nRun `node update-data.js` (or the scheduled Action) to write data/snapshots/index.json.');
    }
}

main();
