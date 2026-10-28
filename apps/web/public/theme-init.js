/*
 * Resolves the stored theme choice (light | dark | system) to data-theme on
 * <html> before first paint. A plain blocking script from our own origin: no
 * inline code (CSP-friendly), and tiny enough that the extra request is cheap and
 * cacheable. Failure to read storage falls back to the OS preference, then light.
 */
(function () {
  var root = document.documentElement;
  var pref = "system";
  try {
    var stored = window.localStorage.getItem("xa-theme");
    if (stored === "light" || stored === "dark") pref = stored;
  } catch (e) {}
  var dark = false;
  try {
    dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {}
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-pref", pref);
})();
