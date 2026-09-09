export type ExtensionBuildProfile = "production" | "development" | "e2e";

export const EXTENSION_BUILD_OUTPUTS: Readonly<Record<ExtensionBuildProfile, string>>;

export function resolveExtensionBuild(options?: {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}): Readonly<{ profile: ExtensionBuildProfile; outdir: string }>;
