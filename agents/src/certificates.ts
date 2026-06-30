// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { log } from './log.js';

const require = createRequire(import.meta.url);

const systemCaFiles = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/pki/tls/cacert.pem',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/etc/ssl/cert.pem',
  '/usr/local/etc/openssl/cert.pem',
  '/opt/homebrew/etc/openssl@3/cert.pem',
];

const systemCaDirs = [
  '/etc/ssl/certs',
  '/etc/pki/tls/certs',
  '/etc/pki/ca-trust/extracted/pem',
  '/system/etc/security/cacerts',
];

function pathIsFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathIsDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** @internal */
export function hasSystemTrustStore(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return true;
  }

  return systemCaFiles.some(pathIsFile) || systemCaDirs.some(pathIsDirectory);
}

/** @internal */
export function setDefaultCertEnv(): void {
  if (process.env.SSL_CERT_FILE || process.env.SSL_CERT_DIR || hasSystemTrustStore()) {
    return;
  }

  const certifiPath = require('certifi') as string;
  process.env.SSL_CERT_FILE = certifiPath;
  process.env.NODE_EXTRA_CA_CERTS ||= certifiPath;
  log().debug('no system trust store found, setting SSL_CERT_FILE to the certifi bundle');
}
