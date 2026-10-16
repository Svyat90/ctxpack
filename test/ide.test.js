import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ideRootFor } from '../src/ide.js';

const wsl = { WSL_DISTRO_NAME: 'Ubuntu' };

test('outside WSL the root is used as is', () => {
  assert.equal(ideRootFor('/Users/me/app', {}, {}, 'darwin'), '/Users/me/app');
  assert.equal(ideRootFor('/home/me/app', {}, {}, 'linux'), '/home/me/app');
});

test('under WSL the root becomes a Windows path', () => {
  assert.equal(ideRootFor('/home/me/app', {}, wsl, 'linux'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\app');
  assert.equal(ideRootFor('/mnt/c/Users/me/app', {}, wsl, 'linux'), 'C:\\Users\\me\\app');
  assert.equal(ideRootFor('/mnt/d', {}, wsl, 'linux'), 'D:\\');
});

test('ideRoot from the config wins', () => {
  assert.equal(ideRootFor('/home/me/app', { ideRoot: '\\\\wsl$\\Ubuntu\\home\\me\\app\\' }, wsl, 'linux'), '\\\\wsl$\\Ubuntu\\home\\me\\app');
});
