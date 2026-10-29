/*
 * Resolves data-theme on <html> before first paint. The public website is always
 * light; only the signed-in application follows the stored choice (light | dark |
 * system, default light). The stored choice is read here but never written. The route list must
 * match THEMED_ROUTE_PREFIXES in lib/theme.ts (a unit test compares them).
 *
 * A plain blocking script from our own origin: no inline code (CSP-friendly), and
 * tiny enough that the extra request is cheap and cacheable. No stored choice, or storage that cannot be read, means the approved
 * light appearance; "system" (follow the OS) applies only when it was chosen.
 */
(function () {
  var root = document.documentElement;
  var pref = "light";
  try {
    var stored = window.localStorage.getItem("xa-theme");
    if (stored === "light" || stored === "dark" || stored === "system") pref = stored;
  } catch (e) {}
  var themed = ["/dashboard", "/jobs", "/matches", "/tracker", "/profile", "/resume", "/cover-letter", "/application-answers", "/demographics", "/settings", "/design-system-specimen"];
  var path = window.location.pathname;
  var inApp = false;
  for (var i = 0; i < themed.length; i++) {
    if (path === themed[i] || path.indexOf(themed[i] + "/") === 0) inApp = true;
  }
  var dark = false;
  try {
    dark = inApp && (pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));
  } catch (e) {}
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.setAttribute("data-theme-pref", pref);
})();
