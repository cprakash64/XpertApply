/**
 * Collect every dist-relative file path a manifest references, so both the build
 * (build.mjs) and a unit test can assert they all exist. Shared to avoid drift.
 */
export function collectManifestFiles(manifest) {
  const files = [];
  for (const icon of Object.values(manifest.icons ?? {})) files.push(icon);
  if (typeof manifest.action?.default_icon === "string") files.push(manifest.action.default_icon);
  else for (const icon of Object.values(manifest.action?.default_icon ?? {})) files.push(icon);
  if (manifest.background?.service_worker) files.push(manifest.background.service_worker);
  if (manifest.side_panel?.default_path) files.push(manifest.side_panel.default_path);
  for (const entry of manifest.content_scripts ?? []) {
    for (const js of entry.js ?? []) files.push(js);
    for (const css of entry.css ?? []) files.push(css);
  }
  for (const res of manifest.web_accessible_resources ?? []) {
    for (const r of res.resources ?? []) files.push(r);
  }
  // De-duplicate while preserving order.
  return [...new Set(files)];
}

/** The entry-point basenames the build is expected to emit (from build.mjs). */
export const EXPECTED_BUILD_OUTPUTS = [
  "background.js",
  "content.js",
  "sidepanel.js",
  "sidepanel.html",
  "manifest.json",
  "icons/xpertapply-16.png",
  "icons/xpertapply-32.png",
  "icons/xpertapply-48.png",
  "icons/xpertapply-128.png"
];
