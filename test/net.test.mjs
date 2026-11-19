import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocalNetwork, privateHostReason } from '../host/shared/net.js'

test('net: the ranges both components act on are recognised', () => {
  // 浏览器拿它拒绝导航，代理拿它决定直连；名单只有这一份。
  for (const host of [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    '::ffff:10.0.0.1',
    '[::1]',
  ]) {
    assert.equal(isLocalNetwork(host), true, host)
  }
  for (const host of ['example.com', '172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', '2001:db8::1', '']) {
    assert.equal(isLocalNetwork(host), false, host)
  }
})

test('net: the reason names the kind of address it refused', () => {
  assert.equal(privateHostReason('127.0.0.1'), '本机回环地址')
  assert.equal(privateHostReason('10.1.2.3'), '私有网段地址')
  assert.equal(privateHostReason('169.254.169.254'), '链路本地地址')
  assert.equal(privateHostReason('::1'), '本机回环地址')
  assert.equal(privateHostReason('example.com'), null)
})
