// @ts-check

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runAsScript, VerificationError } from './lib/cli.mjs';

/**
 * @typedef {object} PackageManifest
 * @property {string} name
 * @property {string} version
 */

/**
 * Fail-closed release validation. A missing/mismatched tag or an already
 * published version is a verification failure. If the registry cannot be
 * checked, publication cannot safely continue.
 *
 * @param {object} options
 * @param {string | undefined} options.tag
 * @param {PackageManifest} options.manifest
 * @param {typeof fetch} options.fetchImpl
 * @returns {Promise<string>}
 */
export async function verifyReleaseTag({ tag, manifest, fetchImpl }) {
  if (!tag) {
    throw new VerificationError(
      'GITHUB_REF_NAME is required (for example, GITHUB_REF_NAME=v0.2.0).',
    );
  }

  const expectedTag = `v${manifest.version}`;
  if (tag !== expectedTag) {
    throw new VerificationError(
      `Tag ${tag} does not match package.json version ${manifest.version}; expected ${expectedTag}. ` +
        'Create the matching tag on the commit that bumps package.json.',
    );
  }

  const packageUrl = `https://registry.npmjs.org/${manifest.name.replace('/', '%2F')}/${manifest.version}`;
  let response;
  try {
    response = await fetchImpl(packageUrl, {
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    throw new Error(
      `Unable to query the npm registry (${packageUrl}); publication cannot be verified safely.`,
      { cause },
    );
  }

  if (response.status === 200) {
    throw new VerificationError(
      `${manifest.name}@${manifest.version} is already published. Bump the version and create a new tag.`,
    );
  }
  if (response.status !== 404) {
    throw new Error(
      `The npm registry returned unexpected status ${response.status} for ${packageUrl}; publication cannot be verified safely.`,
    );
  }

  return `Release verified: tag ${tag} corresponds to ${manifest.name}@${manifest.version}.`;
}

export async function main() {
  const root = resolve(import.meta.dirname, '..');
  /** @type {PackageManifest} */
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), { encoding: 'utf8' }),
  );
  console.log(
    await verifyReleaseTag({
      tag: process.env.GITHUB_REF_NAME,
      manifest,
      fetchImpl: fetch,
    }),
  );
}

runAsScript(import.meta.url, main);
