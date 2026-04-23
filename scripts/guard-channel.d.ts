/**
 * Validate that a semver version string is compatible with the target publish
 * channel, using the odd/even minor convention.
 *
 * Throws an Error with a descriptive message on any problem.
 * Returns void on success.
 *
 * @param version  - The version string from package.json (e.g. "1.2.0").
 * @param channel  - The intended publish channel: "stable" or "prerelease".
 * @throws {Error} If version is malformed, channel is unknown, or minor parity
 *                 does not match the channel.
 */
export function validateChannel(
  version: string,
  channel: "stable" | "prerelease"
): void;
