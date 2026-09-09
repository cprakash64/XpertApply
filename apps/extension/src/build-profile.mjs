export const EXTENSION_BUILD_OUTPUTS = Object.freeze({
  production: "dist",
  development: "dist-development",
  e2e: "dist-e2e-granted"
});

function profileFromArguments(argv) {
  let profile;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      if (profile !== undefined || index + 1 >= argv.length) {
        throw new Error("Expected exactly one value for --profile");
      }
      profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) {
      if (profile !== undefined) throw new Error("Build profile was specified more than once");
      profile = argument.slice("--profile=".length);
      continue;
    }
    throw new Error(`Unsupported extension build argument: ${argument}`);
  }
  return profile;
}

/** Resolve a build to its one permitted output directory.
 *
 * Official scripts pass --profile, which deliberately wins over a stale
 * XPERTAPPLY_EXTENSION_BUILD_PROFILE value. The output environment variable is
 * retained only for compatibility and may repeat, but never change, the fixed
 * profile/output pairing.
 */
export function resolveExtensionBuild({ argv = [], env = {} } = {}) {
  const argumentProfile = profileFromArguments(argv);
  const profile = argumentProfile ?? env.XPERTAPPLY_EXTENSION_BUILD_PROFILE ?? "production";
  const outdir = EXTENSION_BUILD_OUTPUTS[profile];
  if (!outdir) throw new Error(`Unsupported XPERTAPPLY_EXTENSION_BUILD_PROFILE: ${profile}`);

  const requestedOutdir = env.XPERTAPPLY_EXTENSION_OUTDIR;
  if (requestedOutdir !== undefined && requestedOutdir !== outdir) {
    throw new Error(`Invalid extension build profile/output pairing: ${profile} -> ${requestedOutdir}; expected ${outdir}`);
  }
  return Object.freeze({ profile, outdir });
}
