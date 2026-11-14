import test from 'node:test'
import assert from 'node:assert/strict'
import {
  debArchitecture, debTriplet, installCommand, missingLibraries,
  packagesFor, parsePackagesIndex, resolveClosure,
} from '../host/browser/lib/libraries.js'

const INDEX = `Package: libglib2.0-0
Version: 1:2.74.6-2
Depends: libc6 (>= 2.34), libpcre2-8-0 (>= 10.22), libmount1 (>= 2.30)
Filename: pool/main/g/glib2.0/libglib2.0-0_2.74.6-2_arm64.deb

Package: libmount1
Version: 2.38.1-5
Depends: libc6 (>= 2.34), libselinux1 (>= 3.1)
Filename: pool/main/u/util-linux/libmount1_2.38.1-5_arm64.deb

Package: libselinux1
Version: 3.4-1
Depends: libc6 (>= 2.34)
Filename: pool/main/libs/libselinux1/libselinux1_3.4-1_arm64.deb

Package: libnss3
Version: 2:3.87.1-1
Depends: libnspr4, libc6 (>= 2.34), libnspr4 (>= 2:4.12)
Filename: pool/main/n/nss/libnss3_3.87.1-1_arm64.deb

Package: libnspr4
Version: 2:4.35-1
Depends: libc6 (>= 2.34)
Filename: pool/main/n/nspr/libnspr4_4.35-1_arm64.deb

Package: fonts-liberation
Version: 1:1.07.4-11
Depends: fonts-liberation2 | fonts-liberation
Filename: pool/main/f/fonts-liberation/fonts-liberation_1.07.4-11_all.deb

Package: fonts-liberation2
Version: 2.1.5-1
Filename: pool/main/f/fonts-liberation2/fonts-liberation2_2.1.5-1_all.deb`

test('missing libraries are read from loader errors and ldd output', () => {
  assert.deepEqual(
    missingLibraries('chrome: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file'),
    ['libglib-2.0.so.0'],
  )
  assert.deepEqual(
    missingLibraries('\tlibnss3.so => not found\n\tlibnspr4.so => not found\n\tlibc.so.6 => /lib/libc.so.6'),
    ['libnss3.so', 'libnspr4.so'],
  )
  assert.deepEqual(missingLibraries('everything is fine'), [])
})

test('sonames map to packages, fonts are always included, command stays pasteable', () => {
  const packages = packagesFor(['libglib-2.0.so.0', 'libnss3.so', 'libunknown.so.9'])
  assert.ok(packages.includes('libglib2.0-0'))
  assert.ok(packages.includes('libnss3'))
  assert.ok(packages.includes('fonts-liberation'))
  assert.ok(!packages.some((name) => name.includes('unknown')))
  assert.match(installCommand(packages), /^apt-get update && apt-get install -y --no-install-recommends /u)
  assert.equal(installCommand([]), '')
})

test('the dependency closure follows alternatives and never pulls in libc', () => {
  const index = parsePackagesIndex(INDEX)
  assert.equal(index.get('libnss3').filename, 'pool/main/n/nss/libnss3_3.87.1-1_arm64.deb')

  const closure = resolveClosure(index, ['libglib2.0-0', 'libnss3'])
  assert.deepEqual(closure, ['libglib2.0-0', 'libmount1', 'libnspr4', 'libnss3', 'libselinux1'])
  assert.ok(!closure.includes('libc6'), 'the host provides libc')

  // An alternative dependency resolves through its first usable branch.
  const fonts = resolveClosure(index, ['fonts-liberation'])
  assert.deepEqual(fonts, ['fonts-liberation', 'fonts-liberation2'])
})

test('platform names match Debian multiarch directories', () => {
  assert.equal(debArchitecture('arm64'), 'arm64')
  assert.equal(debArchitecture('x64'), 'amd64')
  assert.throws(() => debArchitecture('ia32'), /no Debian packages/u)
  assert.equal(debTriplet('arm64'), 'aarch64-linux-gnu')
  assert.equal(debTriplet('x64'), 'x86_64-linux-gnu')
})
