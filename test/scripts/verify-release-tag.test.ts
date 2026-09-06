import { describe, expect, it, vi } from 'vitest';

import { VerificationError } from '../../scripts/lib/cli.mjs';
import { verifyReleaseTag } from '../../scripts/verify-release-tag.mjs';

const manifest = { name: '@tarahi/cfnsync', version: '1.2.3' };

describe('release tag verification', () => {
  it('rejects a tag that does not match the package version before querying npm', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      verifyReleaseTag({ tag: 'v1.2.2', manifest, fetchImpl }),
    ).rejects.toBeInstanceOf(VerificationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a version that is already published', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      verifyReleaseTag({ tag: 'v1.2.3', manifest, fetchImpl }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  it('fails closed when fetch rejects before a response is assigned', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('registry unavailable'));

    await expect(
      verifyReleaseTag({ tag: 'v1.2.3', manifest, fetchImpl }),
    ).rejects.toThrow(/publication cannot be verified safely/);
  });

  it('accepts an unpublished version only when npm returns 404', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      verifyReleaseTag({ tag: 'v1.2.3', manifest, fetchImpl }),
    ).resolves.toBe(
      'Release verified: tag v1.2.3 corresponds to @tarahi/cfnsync@1.2.3.',
    );
  });
});
