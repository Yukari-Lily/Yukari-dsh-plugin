/**
 * Version arithmetic and the install-target guard.
 *
 * The panel sends one exact version; the tool argument is model output. A range
 * or a path there is not a formatting quibble — it makes `npm install -g` resolve
 * to a different package than the button said.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { candidatesOf, compare, isVersionText, matchChannel, pickLatest, satisfiesRange } from '../host/runtime/lib/versions.js'

test('compare: release outranks its prerelease, numbers decide first', () => {
  assert.ok(compare('0.2.2', '0.2.2-rc.1') > 0)
  assert.ok(compare('0.2.2-rc.2', '0.2.2-rc.1') > 0)
  assert.ok(compare('0.2.10', '0.2.9') > 0)
  assert.equal(compare('0.2.2-rc.1', '0.2.2-rc.1'), 0)
})

test('compare: numeric prerelease identifiers sort below text ones', () => {
  assert.ok(compare('1.0.0-rc.1', '1.0.0-rc.beta') < 0)
  assert.ok(compare('1.0.0-alpha', '1.0.0-beta') < 0)
})

test('matchChannel: releases belong to every channel, prereleases to their tag', () => {
  assert.equal(matchChannel('0.2.2', 'stable'), true)
  assert.equal(matchChannel('0.2.2-rc.1', 'stable'), false)
  assert.equal(matchChannel('0.2.2-rc.1', 'rc'), true)
  assert.equal(matchChannel('0.2.2-beta.3', 'rc'), false)
  assert.equal(matchChannel('0.2.2-beta.3', 'beta'), true)
  assert.equal(matchChannel('0.2.2-alpha.3', 'alpha'), true)
})

test('pickLatest: takes the largest version of the channel only', () => {
  const versions = ['0.2.1', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2', '0.3.0-alpha.1']
  assert.equal(pickLatest(versions, 'rc'), '0.2.2')
  assert.equal(pickLatest(versions, 'alpha'), '0.3.0-alpha.1')
  assert.equal(pickLatest(['0.2.2-rc.1'], 'stable'), undefined)
  assert.equal(pickLatest([], 'rc'), undefined)
})

test('isVersionText: exact versions pass, ranges and paths do not', () => {
  for (const value of ['1.2.3', '0.2.2-rc.1', '0.2.2-beta.3+deadbeef', '2.0.0-alpha.1']) {
    assert.equal(isVersionText(value), true, value)
  }
  for (const value of ['', 'rc', 'latest', '^1.2.3', '~1.2.3', 'file:/tmp/pkg.tgz', '1.2', '1.2.3.4', '../../evil', '1.2.3 || 2.0.0']) {
    assert.equal(isVersionText(value), false, value)
  }
})

test('isVersionText: surrounding whitespace is trimmed, inner text is not accepted', () => {
  assert.equal(isVersionText('  1.2.3  '), true)
  assert.equal(isVersionText('1.2.3 - 2.0.0'), false)
})

test('satisfiesRange: the forms npm engines actually use', () => {
  assert.equal(satisfiesRange('24.22.2', '>=24.9.0'), true)
  assert.equal(satisfiesRange('24.8.0', '>=24.9.0'), false)
  assert.equal(satisfiesRange('22.12.0', '>=24.9.0 <25'), false)
  assert.equal(satisfiesRange('24.9.0', '>=24.9.0 <25'), true)
  assert.equal(satisfiesRange('25.0.0', '>=24.9.0 <25'), false)
  assert.equal(satisfiesRange('20.11.0', '^20 || ^22'), true)
  assert.equal(satisfiesRange('21.0.0', '^20 || ^22'), false)
  assert.equal(satisfiesRange('0.2.9', '~0.2.3'), true)
  assert.equal(satisfiesRange('0.3.0', '~0.2.3'), false)
  assert.equal(satisfiesRange('24.1.0', '24.x'), true)
  assert.equal(satisfiesRange('25.1.0', '24.x'), false)
  assert.equal(satisfiesRange('24.1.0', '*'), true)
  // 解析不出来的写法不拦升级：这是安全网，不是许可证解析器。
  assert.equal(satisfiesRange('24.1.0', 'workspace:*'), true)
})

test('candidatesOf: newest first, channel filtered', () => {
  const versions = ['0.2.1', '0.2.2-rc.1', '0.2.2-rc.10', '0.2.2-rc.2', '0.3.0-alpha.1']
  assert.deepEqual(candidatesOf(versions, 'rc'), ['0.2.2-rc.10', '0.2.2-rc.2', '0.2.2-rc.1', '0.2.1'])
  assert.deepEqual(candidatesOf(versions, 'alpha'), ['0.3.0-alpha.1', '0.2.2-rc.10', '0.2.2-rc.2', '0.2.2-rc.1', '0.2.1'])
  assert.deepEqual(candidatesOf([], 'rc'), [])
})
