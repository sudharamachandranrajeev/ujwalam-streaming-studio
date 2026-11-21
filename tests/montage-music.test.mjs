// SPDX-License-Identifier: GPL-3.0-or-later
// Montage music, the NCS library (D413 item 2, D414): clips.montageMusic in settings.json (on by default, checks, part by
// part save), the studio route that lists the folder's tracks with their credits and saves an edit (real Python, temp
// folders), and posting: a montage with a library track gets the credit in its description, one with a track and no
// credit is never packaged or sent (fail closed, plain words), and one with a song from elsewhere is render only.
// Temp dirs only; no network; process.execPath stands in for ffmpeg (the cover step fails, as in posting-uploads).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPostStore, loadLimits, packageUploads } from '../services/posting/index.mjs';
import { creditMissing, musicCredit } from '../services/posting/post-text.mjs';
import { uploadVideo } from '../services/posting/youtube.mjs';
import { createMontageMusic, montageMusicOpProblems } from '../services/studio-ui/montage-music.mjs';
import { pythonIn } from '../services/studio-ui/record-clips.mjs';
import { montageMusicInfo, montageMusicProblems, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.UJWALAM_TEST_PYTHON || pythonIn(ROOT)?.exe || null;
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-mm-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const CREDIT = { artist: 'Alpha Artist', title: 'First Song', line: 'Music provided by NoCopyrightSounds', link: '' };
const TEXT = 'Song: Alpha Artist - First Song [NCS Release]\nMusic provided by NoCopyrightSounds';

describe('settings', () => {
  test('on by default with random and the last 3 not repeated; a saved change keeps the other parts', () => {
    const d = mk();
    assert.deepEqual(montageMusicInfo(d).value, { on: true, folder: '', mode: 'random', fixedTrack: null, avoidLast: 3 });
    assert.deepEqual(settingsProblems({ clips: { montageMusic: { folder: 'D:\\Music\\NCS', mode: 'random' } } }), []);
    writeSettings(d, { clips: { montageMusic: { folder: 'D:\\Music\\NCS' } } });
    writeSettings(d, { clips: { montageMusic: { avoidLast: 5 } } });
    assert.deepEqual(readSettings(d).clips.montageMusic, { folder: 'D:\\Music\\NCS', avoidLast: 5 });
    assert.equal(montageMusicInfo(d).value.on, true);
  });
  test('bad values are refused in plain words', () => {
    const bad = [{ on: 'yes' }, { folder: 'Music' }, { folder: '\\\\server\\share' }, { mode: 'shuffle' }, { fixedTrack: '../x' },
      { avoidLast: 50 }, { avoidLast: 1.5 }, { extra: 1 }, { mode: 'fixed', fixedTrack: null }];
    for (const v of bad) assert.ok(montageMusicProblems(v).length, JSON.stringify(v));
    assert.match(montageMusicProblems({ folder: 'Music' })[0], /full folder path/);
  });
});

describe('studio route', () => {
  test('shape checks', () => {
    assert.deepEqual(montageMusicOpProblems({ op: 'credit', id: 'a'.repeat(16), credit: CREDIT }), []);
    for (const b of [null, { op: 'scan' }, { op: 'credit', id: 'x', credit: CREDIT }, { op: 'credit', id: 'a'.repeat(16), credit: { artist: 1 } },
      { op: 'credit', id: 'a'.repeat(16), credit: { who: 'x' } }, { op: 'credit', id: 'a'.repeat(16), credit: CREDIT, folder: 'C:\\' }]) {
      assert.ok(montageMusicOpProblems(b).length, JSON.stringify(b));
    }
  });
  test('lists the saved folder with credits from the file names; an edit is saved and kept', { skip: PY ? false : 'no project Python' }, async () => {
    const data = mk(); const music = mk();
    writeFileSync(path.join(music, 'Alpha Artist - First Song [NCS Release].mp3'), 'x');
    writeFileSync(path.join(music, 'untitled.mp3'), 'x');
    const mm = createMontageMusic({ dataDir: data, clipRoot: ROOT, python: PY });
    assert.deepEqual((await mm.info()).tracks, [], 'no folder saved: nothing listed');
    writeSettings(data, { clips: { montageMusic: { folder: music } } });
    const a = await mm.info();
    assert.equal(a.folderProblem, null);
    const byFile = Object.fromEntries(a.tracks.map((t) => [t.file, t]));
    assert.equal(byFile['Alpha Artist - First Song [NCS Release].mp3'].complete, true);
    assert.equal(byFile['untitled.mp3'].complete, false);
    const id = byFile['untitled.mp3'].id;
    const bad = await mm.run({ op: 'credit', id, credit: { artist: '', title: 'x', line: '', link: '' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.detail, /artist is missing/);
    const ok = await mm.run({ op: 'credit', id, credit: { artist: 'Real', title: 'Song', line: 'Music provided by NoCopyrightSounds', link: '' } });
    assert.deepEqual([ok.status, ok.body.complete], [200, true]);
    const b = await mm.info();
    assert.equal(b.tracks.find((t) => t.id === id).artist, 'Real');
    writeSettings(data, { clips: { montageMusic: { folder: path.join(music, 'nope') } } });
    assert.equal((await mm.info()).folderProblem, 'folder not found');
  });
});

describe('posting', () => {
  test('musicCredit: library track with a credit, without one, and a song from elsewhere', () => {
    assert.deepEqual(musicCredit(undefined), { use: 'none' });
    assert.deepEqual(musicCredit({ library: 'ncs', trackId: 'a', credit: CREDIT }), { use: 'credit', text: TEXT });
    assert.equal(musicCredit({ library: 'ncs', trackId: 'a', credit: { ...CREDIT, link: 'https://ncs.io/x' } }).text, `${TEXT}\nhttps://ncs.io/x`);
    const none = musicCredit({ library: 'ncs', trackId: 'a', credit: null });
    assert.deepEqual([none.use, none.renderOnly], ['refuse', false]);
    assert.match(none.reason, /not sent: the song has no credit/);
    assert.equal(musicCredit({ library: 'ncs', credit: { ...CREDIT, artist: '<b>' } }).use, 'refuse');
    const other = musicCredit({ library: null });
    assert.deepEqual([other.use, other.renderOnly], ['refuse', true]);
    assert.match(other.reason, /render only, not auto-posted/);
  });

  function setup(rows) {
    const dataDir = mk(); const clips = mk();
    mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
    const files = rows.map((r, i) => {
      const file = path.join(clips, r.name);
      writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
      const { name, ...rest } = r;
      return { file, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-21T09:00:00.000Z', kind: 'montage', seconds: 45, ...rest };
    });
    mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files }));
    return { dataDir, ledgerFile: path.join(dataDir, 'posting', 'ledger.json') };
  }

  test('packaging adds the credit; no credit and other songs are not packaged; approve and upload check again', async () => {
    const e = setup([
      { name: 'codm_montage_20261121-100000_kills-5_01_v.mp4', montageMusic: { library: 'ncs', trackId: 'a'.repeat(16), credit: CREDIT } },
      { name: 'codm_montage_20261121-100500_kills-6_02_v.mp4', montageMusic: { library: 'ncs', trackId: 'b'.repeat(16), credit: null } },
      { name: 'codm_montage_20261121-101000_kills-7_03_v.mp4', montageMusic: { library: null } },
      { name: 'codm_montage_20261121-101500_kills-8_04_v.mp4' },
    ]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath });
    assert.equal(r.packaged.length, 2, JSON.stringify(r.skipped));
    const why = (key) => r.skipped.find((s) => s.file.includes(key));
    assert.equal(why('100500').reason, 'music-credit-missing');
    assert.match(why('100500').detail, /Settings > Clips > Montage music/);
    assert.equal(why('101000').reason, 'render-only');
    const store = createPostStore({ ledgerFile: e.ledgerFile });
    const withSong = store.list().length === 2;
    const pkgDir = r.packaged.map((p) => p.dir).find((d) => JSON.parse(readFileSync(path.join(d, 'post.json'), 'utf8')).source.musicCredit);
    assert.ok(pkgDir, 'one package carries the credit');
    const post = JSON.parse(readFileSync(path.join(pkgDir, 'post.json'), 'utf8'));
    assert.ok(post.description.endsWith(TEXT), post.description);
    assert.equal(post.source.montageMusic.library, 'ncs');
    assert.equal(creditMissing(post), null);
    assert.ok(withSong);
    // the user removes the credit from the description: approve refuses, and an upload would refuse too
    const id = store.list().find((p) => p.dir === pkgDir || p.clipId === post.source.clipId).id;
    writeFileSync(path.join(pkgDir, 'post.json'), JSON.stringify({ ...post, description: 'my own text' }));
    assert.equal(await store.setStatus(id, 'approved'), 'music-credit-missing');
    const gone = { ...post, description: 'my own text', status: 'approved', unresolved: [] }; // the empty test profile leaves handles open
    assert.equal(creditMissing(gone), 'music-credit-missing');
    assert.equal(creditMissing({ ...gone, source: { ...gone.source, musicCredit: undefined } }), 'music-credit-missing');
    assert.equal(creditMissing({ description: 'x', source: {} }), null, 'no montage song: nothing to check');
    await assert.rejects(uploadVideo({ post: gone, sha256: post.source.sha256, videoPath: 'x', accessToken: 't', ledger: { get: () => null },
      limits: loadLimits(), publishAt: '2026-12-01T10:00:00Z', outputsStatus: async () => ({ sinks: [] }), fetchImpl: () => { throw new Error('network used'); } }),
    (err) => err.code === 'music-credit-missing');
  });
});
