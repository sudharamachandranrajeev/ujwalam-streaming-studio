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
import { createPostChain } from '../services/posting/auto-chain.mjs';
import { PROVENANCE_FILE, creditMissing, legacyMadeHere, musicCredit, musicOf, readProvenanceSince } from '../services/posting/post-text.mjs';
import { MUSIC_SIDECAR, scanClipsFolder, videoBinding } from '../services/posting/clips-source.mjs';
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
    writeFileSync(path.join(music, 'Alpha Artist - First Song [NCS Release].mp3'), 'song one');
    writeFileSync(path.join(music, 'untitled.mp3'), 'song two');
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
      { name: 'codm_montage_20261121-101500_kills-8_04_v.mp4', music: { source: 'generated' } },
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
    assert.deepEqual(post.source.music, { checked: 1, use: 'credit', library: 'ncs', trackId: 'a'.repeat(16) });
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

  test('Codex BD review: provenance from the render record; unknown records are held, made-here music posts', async () => {
    assert.equal(musicOf({ kind: 'montage' }), 'unknown', 'no record and no legacy pass');
    assert.equal(musicOf({ kind: 'montage' }, { legacyMadeHere: true }), undefined, 'legacy: made here');
    assert.equal(musicOf({ kind: 'montage', music: { source: 'unknown' } }, { legacyMadeHere: true }), 'unknown', 'a new render without a record');
    assert.equal(musicOf({ kind: 'montage', music: { source: 'mystery' } }), 'unknown');
    assert.equal(musicOf({ kind: 'montage', music: { source: 'generated' } }), undefined);
    assert.equal(musicOf({ kind: 'montage', music: { source: 'none' } }), undefined);
    assert.deepEqual(musicOf({ kind: 'won-reel', music: { source: 'user-folder', track: 't' } }), { library: null });
    assert.deepEqual(musicOf({ kind: 'montage', music: { source: 'ncs', trackId: 'a', credit: CREDIT } }), { library: 'ncs', trackId: 'a', credit: CREDIT });
    const e = setup([
      { name: 'codm_montage_20261121-110000_kills-5_01_v.mp4', music: { source: 'unknown' } },
      { name: 'codm_montage_20261121-110500_kills-6_02_v.mp4', music: { source: 'user-folder', track: 'x' } },
      { name: 'codm_montage_20261121-111000_kills-7_03_v.mp4', music: { source: 'ncs', trackId: 'c'.repeat(16), credit: CREDIT } },
      { name: 'codm_won-reel_20261121-111500_victory-kills-4_04_v.mp4', kind: 'won-reel', music: { source: 'generated' } },
    ]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath });
    const why = (key) => r.skipped.find((s) => s.file.includes(key));
    assert.equal(why('110000').reason, 'music-unknown');
    assert.equal(why('110000').detail, "re-render to post: the song's source is not known");
    assert.equal(why('110500').reason, 'render-only');
    assert.equal(r.packaged.length, 2, JSON.stringify(r.skipped));
    const credited = r.packaged.map((p) => JSON.parse(readFileSync(path.join(p.dir, 'post.json'), 'utf8'))).find((p) => p.source.musicCredit);
    assert.ok(credited.description.endsWith(TEXT));
  });

  // Coordinator rule 2026-11-21: clips rendered before music records, every kind alike
  const LEGACY = [
    { name: 'codm_montage_20261121-130000_kills-5_01_v.mp4' },
    { name: 'codm_won-reel_20261121-130500_victory-kills-4_02_v.mp4', kind: 'won-reel' },
    { name: 'codm_impact-play_20261121-131000_triple-kill_03_v.mp4', kind: 'impact-play', seconds: 20 },
    { name: 'codm_short_20261121-131500_triple-kill_04_v.mp4', kind: 'short', seconds: 12 },
  ];
  test('legacy clips (no record): no music folder ever set and no library pick -> made here, every kind posts', async () => {
    const e = setup(LEGACY);
    assert.equal(legacyMadeHere(e.dataDir), true);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath, flags: { isOn: () => true } });
    assert.equal(r.packaged.length, 4, JSON.stringify(r.skipped));
  });
  test('legacy clips: a music folder set in Clip look, or a library track ever picked -> held as unknown, every kind', async () => {
    const a = setup(LEGACY);
    writeSettings(a.dataDir, { clips: { look: { music: { folder: 'D:\\Music\\Clips' } } } });
    assert.equal(legacyMadeHere(a.dataDir), false);
    const ra = await packageUploads({ dataDir: a.dataDir, ledgerFile: a.ledgerFile, profile: {}, ffmpeg: process.execPath, flags: { isOn: () => true } });
    assert.equal(ra.packaged.length, 0);
    assert.deepEqual(ra.skipped.map((s) => s.reason), ['music-unknown', 'music-unknown', 'music-unknown', 'music-unknown']);
    assert.ok(ra.skipped.every((s) => s.detail === "re-render to post: the song's source is not known"));
    const b = setup(LEGACY.filter((x) => x.kind === 'won-reel' || x.kind === 'impact-play'));
    mkdirSync(path.join(b.dataDir, 'clips', 'montage-music'), { recursive: true });
    writeFileSync(path.join(b.dataDir, 'clips', 'montage-music', 'history.json'), JSON.stringify({ version: 1, recent: ['a'.repeat(16)] }));
    assert.equal(legacyMadeHere(b.dataDir), false);
    const rb = await packageUploads({ dataDir: b.dataDir, ledgerFile: b.ledgerFile, profile: {}, ffmpeg: process.execPath, flags: { isOn: () => true } });
    assert.deepEqual(rb.skipped.map((s) => s.reason), ['music-unknown', 'music-unknown']);
  });

  test('a folder-scanned clip reads the sidecar the publish step wrote; no sidecar follows the legacy rule', async () => {
    const dataDir = mk(); const clips = mk();
    const day = path.join(clips, '2026-11-21'); mkdirSync(day);
    const put = (name, music) => {
      const f = path.join(day, name); writeFileSync(f, Buffer.from(name.repeat(8)));
      if (music) writeFileSync(`${f}${MUSIC_SIDECAR}`, JSON.stringify({ version: 1, music, video: videoBinding(f) }));
      return f;
    };
    put('codm_montage_20261121-120000_kills-5_01_v.mp4', { source: 'generated' });
    put('codm_montage_20261121-120500_kills-6_02_v.mp4', null);
    put('codm_montage_20261121-121000_kills-7_03_v.mp4', { source: 'user-folder', track: 'x' });
    put('codm_montage_20261121-121500_kills-8_04_v.mp4', { source: 'unknown' });
    // Codex verify: a sidecar bound to other bytes (copied from another video, or the video changed) is unknown
    const forged = put('codm_won-reel_20261121-122000_victory-kills-4_05_v.mp4', { source: 'generated' });
    writeFileSync(forged, Buffer.from('other bytes, same name'));
    const unbound = put('codm_won-reel_20261121-122500_victory-kills-5_06_v.mp4', null);
    writeFileSync(`${unbound}${MUSIC_SIDECAR}`, JSON.stringify({ version: 1, music: { source: 'generated' } }));
    const s = scanClipsFolder({ dataDir, folder: clips, probeSeconds: () => 40 });
    assert.equal(s.rows.length, 6);
    assert.deepEqual(s.rows[4].music, { source: 'unknown' }, 'bound to other bytes');
    assert.deepEqual(s.rows[5].music, { source: 'unknown' }, 'no binding');
    assert.deepEqual(s.rows[0].music, { source: 'generated' });
    assert.equal(s.rows[1].music, undefined);
    const r = await packageUploads({ dataDir, ledgerFile: path.join(dataDir, 'posting', 'ledger.json'), rows: s.rows, profile: {}, ffmpeg: process.execPath });
    assert.equal(r.packaged.length, 2, JSON.stringify(r.skipped));
    assert.deepEqual(r.skipped.map((x) => x.reason).sort(), ['music-unknown', 'music-unknown', 'music-unknown', 'render-only']);
  });

  test('Codex verify: an uploads row counts only while it still describes its video; a replaced video is held', async () => {
    const e = setup([{ name: 'codm_won-reel_20261121-140000_victory-kills-4_01_v.mp4', kind: 'won-reel', music: { source: 'none' } }]);
    const up = path.join(e.dataDir, 'clips', 'uploads.json');
    const doc = JSON.parse(readFileSync(up, 'utf8'));
    const file = doc.files[0].file;
    doc.files[0].video = videoBinding(file);
    writeFileSync(up, JSON.stringify(doc));
    // the no-music video is replaced by a library-music video under the same name (no sidecar for it)
    writeFileSync(file, Buffer.from('a montage with an NCS song, other bytes'.repeat(8)));
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath });
    assert.deepEqual(r.skipped.map((s) => s.reason), ['music-unknown'], 'from uploads.json');
    const s = scanClipsFolder({ dataDir: e.dataDir, folder: path.dirname(path.dirname(file)), probeSeconds: () => 40 });
    assert.equal(s.rows.length, 0, 'not in a day folder: the scan path is checked below');
    const day = path.join(mk(), '2026-11-21'); mkdirSync(day, { recursive: true });
    const moved = path.join(day, path.basename(file));
    writeFileSync(moved, readFileSync(file));
    const doc2 = { version: 1, files: [{ ...doc.files[0], file: moved }] };
    writeFileSync(up, JSON.stringify(doc2));
    const s2 = scanClipsFolder({ dataDir: e.dataDir, folder: path.dirname(day), probeSeconds: () => 40 });
    assert.deepEqual(s2.rows[0].music, { source: 'unknown' }, 'folder scan: the row no longer describes the file');
    // a row whose binding matches keeps its record
    writeFileSync(up, JSON.stringify({ version: 1, files: [{ ...doc2.files[0], video: videoBinding(moved) }] }));
    assert.deepEqual(scanClipsFolder({ dataDir: e.dataDir, folder: path.dirname(day), probeSeconds: () => 40 }).rows[0].music, { source: 'none' });
  });

  test('Codex verify: a replaced video never inherits the row\'s old credit (music and montageMusic only from a trusted source)', async () => {
    const OTHER = { artist: 'Beta Artist', title: 'Second Song', line: 'Music provided by NoCopyrightSounds', link: '' };
    const run = async (replace) => {
      const e = setup([{ name: 'codm_montage_20261121-150000_kills-5_01_v.mp4', montageMusic: { library: 'ncs', trackId: 'a'.repeat(16), credit: CREDIT },
        music: { source: 'ncs', trackId: 'a'.repeat(16), credit: CREDIT } }]);
      const up = path.join(e.dataDir, 'clips', 'uploads.json');
      const doc = JSON.parse(readFileSync(up, 'utf8'));
      const file = doc.files[0].file;
      doc.files[0].video = videoBinding(file);
      writeFileSync(up, JSON.stringify(doc));
      replace(file);
      return packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath });
    };
    const swap = (file, bytes, music) => {
      writeFileSync(file, Buffer.from(bytes.repeat(8)));
      if (music) writeFileSync(`${file}${MUSIC_SIDECAR}`, JSON.stringify({ version: 1, music, video: videoBinding(file) }));
    };
    // folder-music bytes (sidecar says user-folder): render only, never the old credit
    const a = await run((f) => swap(f, 'folder music montage', { source: 'user-folder', track: 'x' }));
    assert.deepEqual([a.packaged.length, a.skipped.map((s) => s.reason)], [0, ['render-only']]);
    // no sidecar at all: unknown, held
    const b = await run((f) => swap(f, 'some other montage', null));
    assert.deepEqual([b.packaged.length, b.skipped.map((s) => s.reason)], [0, ['music-unknown']]);
    // another library track without its own credit: held until that track's credit is present
    const c = await run((f) => swap(f, 'another ncs montage', { source: 'ncs', trackId: 'b'.repeat(16), credit: null }));
    assert.deepEqual([c.packaged.length, c.skipped.map((s) => s.reason)], [0, ['music-credit-missing']]);
    // with its own credit: posted with that credit, not the old one
    const d = await run((f) => swap(f, 'another ncs montage', { source: 'ncs', trackId: 'b'.repeat(16), credit: OTHER }));
    assert.equal(d.packaged.length, 1, JSON.stringify(d.skipped));
    const post = JSON.parse(readFileSync(path.join(d.packaged[0].dir, 'post.json'), 'utf8'));
    assert.match(post.description, /Beta Artist - Second Song/);
    assert.doesNotMatch(post.description, /Alpha Artist/);
    assert.equal(post.source.music.trackId, 'b'.repeat(16));
  });

  test('Codex verify: bindings are cached by path + size + mtime_ns; the auto-post folder scan waits while streaming or recording', async () => {
    const d = mk(); const f = path.join(d, 'v.mp4');
    writeFileSync(f, Buffer.from('x'.repeat(5000)));
    const v1 = videoBinding(f);
    assert.equal(videoBinding(f), v1, 'same object: hashed once');
    writeFileSync(f, Buffer.from('y'.repeat(6000)));
    assert.notEqual(videoBinding(f).head, v1.head, 'changed file: hashed again');
    const dataDir = mk(); const clips = mk();
    mkdirSync(path.join(clips, '2026-11-21'));
    writeFileSync(path.join(clips, '2026-11-21', 'codm_short_20261121-160000_triple-kill_01_v.mp4'), 'x');
    let scans = 0;
    const chain = createPostChain({ dataDir, flags: { isOn: () => true }, rulesSource: { get: () => ({ rules: [{ id: 'r' }] }) }, clipsFolder: clips,
      probeSeconds: () => 10, scanEveryMs: 0, tickEveryMs: 0, profileFile: path.join(dataDir, 'none.json'),
      packageImpl: async () => ({ packaged: [], skipped: [] }), packageUploadsImpl: async () => { scans++; return { packaged: [], skipped: [] }; } });
    const rec = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'active' }] };
    await chain.tick(rec).catch(() => {});
    assert.equal(scans, 0, 'recording: no scan');
    await chain.tick({ sinks: [{ id: 'yt', kind: 'stream', state: 'active' }] }).catch(() => {});
    assert.equal(scans, 0, 'streaming: no scan');
    await chain.tick({ sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'stopped' }] }).catch(() => {});
    assert.equal(scans, 1, 'idle: scanned');
  });

  test('Codex verify: the legacy pass covers only clips older than the provenance start, written once and never moved', async () => {
    const e = setup(LEGACY.filter((x) => x.kind === 'won-reel' || x.kind === 'impact-play'));
    const file = path.join(e.dataDir, ...PROVENANCE_FILE.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    const since = Date.now() - 3600_000;
    writeFileSync(file, JSON.stringify({ version: 1, since: new Date(since).toISOString() }));
    // a won-reel and an impact play made after it (their sidecars lost): held, even with no folder and no pick history
    assert.equal(legacyMadeHere(e.dataDir), true);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath, flags: { isOn: () => true } });
    assert.deepEqual(r.skipped.map((s) => s.reason), ['music-unknown', 'music-unknown']);
    assert.equal(readProvenanceSince(e.dataDir), since, 'never moved');
    // clips older than the start (here: a start after them; a creation time cannot be set back on Windows): posted
    writeFileSync(file, JSON.stringify({ version: 1, since: new Date(Date.now() + 60_000).toISOString() }));
    const r2 = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: {}, ffmpeg: process.execPath, flags: { isOn: () => true } });
    assert.equal(r2.packaged.length, 2, JSON.stringify(r2.skipped));
    // a fresh data folder: the start is made on the first run, after the clips already there
    const f = setup(LEGACY.slice(1, 2));
    assert.equal(readProvenanceSince(f.dataDir), null);
    const r3 = await packageUploads({ dataDir: f.dataDir, ledgerFile: f.ledgerFile, profile: {}, ffmpeg: process.execPath });
    assert.equal(r3.packaged.length, 1, JSON.stringify(r3.skipped));
    const made = readProvenanceSince(f.dataDir);
    assert.ok(Number.isFinite(made));
    await packageUploads({ dataDir: f.dataDir, ledgerFile: f.ledgerFile, profile: {}, ffmpeg: process.execPath });
    assert.equal(readProvenanceSince(f.dataDir), made, 'written once');
  });
});
