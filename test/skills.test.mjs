/**
 * 技能库的单元用例：前言解析、扫描、启停搬迁、编辑与上传。
 *
 * 这些用例全部对着临时 `$DSH_HOME` 跑，不碰真实的技能目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readSkillText } from '../host/skills/lib/frontmatter.js'
import {
  MAX_TEXT_BYTES,
  archiveEntries,
  assertKey,
  libraries,
  listEntries,
  readSkill,
  removeSkill,
  saveSkill,
  scan,
  setEnabled,
} from '../host/skills/lib/library.js'
import { installUpload, readRawBody } from '../host/skills/lib/upload.js'
import { zipBuffer } from './zip-fixture.mjs'

const SKILL = (name, description = 'A test skill.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

/** Run one case against a throwaway harness home. */
async function withHome(run) {
  const previous = process.env.DSH_HOME
  const home = await mkdtemp(path.join(os.tmpdir(), 'yukari-skills-'))
  process.env.DSH_HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------- frontmatter */

test('frontmatter: a valid file reads name, description and the invocation defaults', () => {
  const parsed = readSkillText(`${SKILL('demo-skill')}`)
  assert.equal(parsed.problem, null)
  assert.equal(parsed.name, 'demo-skill')
  assert.equal(parsed.description, 'A test skill.')
  assert.equal(parsed.modelInvocable, true)
  assert.equal(parsed.userInvocable, true)
})

test('frontmatter: block scalars survive, because that is how descriptions are written', () => {
  const parsed = readSkillText('---\nname: blocked\ndescription: |\n  First line.\n  Second line.\n---\nbody\n')
  assert.equal(parsed.problem, null)
  assert.match(parsed.description, /First line\.\nSecond line\./u)
})

test('frontmatter: both invocation switches accept the host spellings', () => {
  const disabled = readSkillText('---\nname: manual\ndescription: d\ndisable-model-invocation: yes\n---\n')
  assert.equal(disabled.problem, null)
  assert.equal(disabled.modelInvocable, false)
  assert.equal(disabled.userInvocable, true)

  const userOff = readSkillText('---\nname: model-only\ndescription: d\nuser-invocable: OFF\n---\n')
  assert.equal(userOff.problem, null)
  assert.equal(userOff.modelInvocable, true)
  assert.equal(userOff.userInvocable, false)

  const numeric = readSkillText('---\nname: numeric\ndescription: d\ndisable-model-invocation: 1\n---\n')
  assert.equal(numeric.modelInvocable, false)
})

test('frontmatter: every reason the host would skip a file is reported, not thrown', () => {
  const cases = [
    ['# no frontmatter', 'no-frontmatter'],
    ['---\nname: [unclosed\n---\n', 'bad-yaml'],
    ['---\ndescription: d\n---\n', 'missing-name'],
    ['---\nname: only-name\n---\n', 'missing-description'],
    ['---\nname: Bad_Name\ndescription: d\n---\n', 'bad-name'],
    ['---\nname: legacy-one\ndescription: d\ndisableModelInvocation: true\n---\n', 'bad-invocation'],
    ['---\nname: legacy-two\ndescription: d\nmodelInvocable: false\n---\n', 'bad-invocation'],
    ['---\nname: legacy-three\ndescription: d\nuserInvocable: false\n---\n', 'bad-invocation'],
    ['---\nname: bad-bool\ndescription: d\nuser-invocable: sometimes\n---\n', 'bad-invocation'],
  ]
  for (const [text, problem] of cases) {
    const parsed = readSkillText(text)
    assert.equal(parsed.problem, problem, `expected ${problem} for ${JSON.stringify(text.slice(0, 24))}`)
    assert.ok(typeof parsed.detail === 'string' && parsed.detail.length > 0, 'a problem comes with a reason')
  }
})

/* ------------------------------------------------------------------ library */

test('scan: directory bundles and flat files are listed, everything else is skipped', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(path.join(root, 'bundle-skill'), { recursive: true })
    await writeFile(path.join(root, 'bundle-skill', 'SKILL.md'), SKILL('bundle-skill'))
    await writeFile(path.join(root, 'flat-skill.md'), SKILL('flat-skill'))
    await writeFile(path.join(root, 'notes.txt'), 'not a skill\n')
    await mkdir(path.join(root, '.system'), { recursive: true })
    await writeFile(path.join(root, '.system', 'SKILL.md'), SKILL('hidden-system'))
    await mkdir(path.join(root, 'no-skill-md'), { recursive: true })
    await writeFile(path.join(root, 'no-skill-md', 'README.md'), 'nothing here\n')
    await symlink(path.join(root, 'bundle-skill'), path.join(root, 'linked-skill'))

    const items = await scan()
    assert.deepEqual(items.map((item) => [item.key, item.form]), [
      ['bundle-skill', 'bundle'],
      ['flat-skill', 'file'],
    ])
    for (const item of items) {
      assert.equal(item.state, 'enabled')
      assert.equal(item.problem, null)
      assert.ok(item.size > 0)
      assert.ok(Number.isFinite(item.mtime))
    }
  })
})

test('scan: a file the host would skip is still listed, with its reason', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'broken.md'), 'no frontmatter here\n')
    const [item] = await scan()
    assert.equal(item.key, 'broken')
    assert.equal(item.problem, 'no-frontmatter')
    assert.ok(item.detail.length > 0)
  })
})

test('keys: separators and dot segments never reach a path join', () => {
  for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'x\0y']) {
    assert.throws(() => assertKey(bad), /技能标识不合法/u, `expected ${JSON.stringify(bad)} to be refused`)
  }
  assert.equal(assertKey('good-key'), 'good-key')
})

test('disable and enable: the file moves, the state follows, the bytes stay identical', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    const disabledRoot = path.join(home, 'skills-disabled')
    await mkdir(root, { recursive: true })
    const text = SKILL('moving-skill')
    await writeFile(path.join(root, 'moving-skill.md'), text)

    const off = await setEnabled('moving-skill', 'file', false)
    assert.equal(off.state, 'disabled')
    assert.deepEqual(await readdir(root), [], 'the enabled root no longer holds it')
    assert.deepEqual(await readdir(disabledRoot), ['moving-skill.md'])
    assert.equal(await readFile(path.join(disabledRoot, 'moving-skill.md'), 'utf8'), text)

    const on = await setEnabled('moving-skill', 'file', true)
    assert.equal(on.state, 'enabled')
    assert.deepEqual(await readdir(disabledRoot), [])
    assert.equal(await readFile(path.join(root, 'moving-skill.md'), 'utf8'), text)
  })
})

test('disable: a taken destination is refused instead of overwriting a skill', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    const disabledRoot = path.join(home, 'skills-disabled')
    await mkdir(root, { recursive: true })
    await mkdir(disabledRoot, { recursive: true })
    await writeFile(path.join(root, 'twin.md'), SKILL('twin', 'enabled copy'))
    await writeFile(path.join(disabledRoot, 'twin.md'), SKILL('twin', 'disabled copy'))

    await assert.rejects(() => setEnabled('twin', 'file', false), (error) => error.appCode === 'skill-exists')
    assert.equal(await readFile(path.join(disabledRoot, 'twin.md'), 'utf8'), SKILL('twin', 'disabled copy'))
    assert.equal(await readFile(path.join(root, 'twin.md'), 'utf8'), SKILL('twin', 'enabled copy'))
  })
})

test('save: invalid text is refused before the file is touched', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(root, { recursive: true })
    const original = SKILL('editable')
    await writeFile(path.join(root, 'editable.md'), original)

    await assert.rejects(
      () => saveSkill('editable', 'file', '---\nname: editable\n---\nno description\n'),
      (error) => error.appCode === 'skill-invalid',
    )
    assert.equal(await readFile(path.join(root, 'editable.md'), 'utf8'), original, 'the file is unchanged')

    const saved = await saveSkill('editable', 'file', SKILL('editable', 'Rewritten.'))
    assert.equal(saved.item.description, 'Rewritten.')
    const leftovers = (await readdir(root)).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'the atomic write leaves no temporary file behind')
  })
})

test('save: an oversized body is refused by name, not by a generic body error', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'big.md'), SKILL('big'))
    const text = `${SKILL('big')}${'x'.repeat(MAX_TEXT_BYTES)}`
    await assert.rejects(() => saveSkill('big', 'file', text), (error) => error.appCode === 'skill-text-too-large')
  })
})

test('readSkill: a body over the editor ceiling is truncated and says so', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'long.md'), `${SKILL('long')}${'y'.repeat(MAX_TEXT_BYTES + 10)}`)
    const read = await readSkill('long', 'file')
    assert.equal(read.truncated, true)
    assert.equal(Buffer.byteLength(read.text, 'utf8'), MAX_TEXT_BYTES)
  })
})

test('remove: a bundle goes away with its whole tree', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(path.join(root, 'tree-skill', 'references'), { recursive: true })
    await writeFile(path.join(root, 'tree-skill', 'SKILL.md'), SKILL('tree-skill'))
    await writeFile(path.join(root, 'tree-skill', 'references', 'a.md'), 'ref\n')

    await removeSkill('tree-skill', 'bundle')
    assert.deepEqual(await readdir(root), [])
    await assert.rejects(() => removeSkill('tree-skill', 'bundle'), (error) => error.appCode === 'skill-not-found')
  })
})

test('archive entries: a bundle keeps its tree, and symlinks are left out', async () => {
  await withHome(async (home) => {
    const root = path.join(home, 'skills')
    await mkdir(path.join(root, 'arch-skill', 'assets'), { recursive: true })
    await writeFile(path.join(root, 'arch-skill', 'SKILL.md'), SKILL('arch-skill'))
    await writeFile(path.join(root, 'arch-skill', 'assets', 'logo.png'), 'not really a png\n')
    await symlink(path.join(root, 'arch-skill', 'SKILL.md'), path.join(root, 'arch-skill', 'assets', 'link.md'))

    const { entries } = await archiveEntries('arch-skill', 'bundle')
    const names = entries.map((entry) => entry.name).sort()
    assert.deepEqual(names, ['arch-skill/SKILL.md', 'arch-skill/assets/', 'arch-skill/assets/logo.png'])
  })
})

/* ------------------------------------------------------------------- upload */

test('upload: a flat .md installs under its frontmatter name', async () => {
  await withHome(async (home) => {
    const result = await installUpload({ bytes: Buffer.from(SKILL('from-upload')), filename: 'whatever.md' })
    assert.equal(result.item.key, 'from-upload')
    assert.equal(result.item.form, 'file')
    assert.equal(await readFile(path.join(home, 'skills', 'from-upload.md'), 'utf8'), SKILL('from-upload'))
  })
})

test('upload: an unknown extension is refused before anything is written', async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => installUpload({ bytes: Buffer.from('x'), filename: 'skill.tar.gz' }),
      (error) => error.appCode === 'skill-kind-unknown',
    )
    assert.deepEqual(await readdir(home), [], 'the harness home is still empty')
  })
})

test('upload: a name that already exists is refused in both shapes', async () => {
  await withHome(async (home) => {
    await installUpload({ bytes: Buffer.from(SKILL('taken')), filename: 'taken.md' })
    await assert.rejects(
      () => installUpload({ bytes: Buffer.from(SKILL('taken', 'another')), filename: 'taken.md' }),
      (error) => error.appCode === 'skill-exists',
    )
    assert.equal(await readFile(path.join(home, 'skills', 'taken.md'), 'utf8'), SKILL('taken'))
  })
})

test('upload: reading a body stops at the ceiling', async () => {
  const request = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(8)
      yield Buffer.alloc(8)
    },
  }
  await assert.rejects(() => readRawBody(request, 10), (error) => error.appCode === 'skill-upload-too-large')
  const empty = { async *[Symbol.asyncIterator]() {} }
  await assert.rejects(() => readRawBody(empty, 10), (error) => error.appCode === 'skill-upload-empty')
})

test('libraries: the two roots sit next to each other under the harness home', () => {
  const { root, disabledRoot } = libraries()
  assert.equal(path.dirname(root), path.dirname(disabledRoot))
  assert.equal(path.basename(root), 'skills')
  assert.equal(path.basename(disabledRoot), 'skills-disabled')
})

test('listEntries: a missing root is empty state, not an error', async () => {
  await withHome(async (home) => {
    assert.deepEqual(await listEntries(path.join(home, 'not-there')), [])
  })
})

test('upload: a zip whose files sit in one wrapping directory installs as a bundle', async () => {
  await withHome(async (home) => {
    const archive = zipBuffer([
      { name: 'zip-skill/SKILL.md', data: SKILL('zip-skill', 'From a zip.') },
      { name: 'zip-skill/references/note.md', data: 'reference\n' },
      { name: 'zip-skill/assets/logo.bin', data: Buffer.from([0, 1, 2]), deflate: false },
    ])
    const result = await installUpload({ bytes: archive, filename: 'zip-skill.zip' })
    assert.equal(result.item.key, 'zip-skill')
    assert.equal(result.item.form, 'bundle')
    assert.equal(result.item.problem, null)
    const root = path.join(home, 'skills', 'zip-skill')
    assert.deepEqual((await readdir(root, { recursive: true })).sort(), [
      'SKILL.md',
      'assets',
      path.join('assets', 'logo.bin'),
      'references',
      path.join('references', 'note.md'),
    ].sort())
    assert.equal(await readFile(path.join(root, 'SKILL.md'), 'utf8'), SKILL('zip-skill', 'From a zip.'))
  })
})

test('upload: a zip with SKILL.md at its top level installs the same way', async () => {
  await withHome(async (home) => {
    const archive = zipBuffer([{ name: 'SKILL.md', data: SKILL('flat-zip') }])
    const result = await installUpload({ bytes: archive, filename: 'flat-zip.zip' })
    assert.equal(result.item.key, 'flat-zip')
    assert.equal(await readFile(path.join(home, 'skills', 'flat-zip', 'SKILL.md'), 'utf8'), SKILL('flat-zip'))
  })
})

test('upload: an archive that climbs out of the staging directory is refused', async () => {
  await withHome(async (home) => {
    const archive = zipBuffer([
      { name: 'SKILL.md', data: SKILL('escaping-skill') },
      { name: '../escaped.md', data: 'should not land anywhere\n' },
    ])
    await assert.rejects(
      () => installUpload({ bytes: archive, filename: 'escaping.zip' }),
      (error) => error.appCode === 'skill-upload-bad-zip',
    )
    assert.deepEqual(await readdir(path.join(home, 'skills')).catch(() => []), [], 'nothing was installed')
  })
})

test('upload: an archive without SKILL.md names the missing file', async () => {
  await withHome(async (home) => {
    const archive = zipBuffer([{ name: 'readme.md', data: 'no skill here\n' }])
    await assert.rejects(
      () => installUpload({ bytes: archive, filename: 'readme.zip' }),
      (error) => error.appCode === 'skill-upload-no-skill-md',
    )
    assert.deepEqual(await readdir(path.join(home, 'skills')).catch(() => []), [])
  })
})

test('upload: a bundle that would not load is refused instead of installed', async () => {
  await withHome(async (home) => {
    const archive = zipBuffer([{ name: 'broken/SKILL.md', data: '---\nname: broken\n---\nno description\n' }])
    await assert.rejects(
      () => installUpload({ bytes: archive, filename: 'broken.zip' }),
      (error) => error.appCode === 'skill-invalid' && error.params?.problem === 'missing-description',
    )
    assert.deepEqual(await readdir(path.join(home, 'skills')).catch(() => []), [])
  })
})

test('upload: the staging directory is removed even when installation fails', async () => {
  const before = new Set(await readdir(os.tmpdir()))
  await withHome(async () => {
    const archive = zipBuffer([{ name: 'readme.md', data: 'nothing\n' }])
    await assert.rejects(() => installUpload({ bytes: archive, filename: 'nothing.zip' }))
  })
  const after = await readdir(os.tmpdir())
  const leftovers = after.filter((name) => name.startsWith('yukari-skill-') && !before.has(name))
  assert.deepEqual(leftovers, [], 'no temporary archive directory survives a failed upload')
})
