"""Focused path-safety tests for the EXT-FINAL-03 trusted state helper and scripts. Run:  python3 -m unittest -v test_extfinal03_state
They use a temporary directory tree owned by the current user and pass that uid as the 'trusted owner'; the production CLI always
uses uid 0 and has no override. Nothing outside the temporary directory is touched."""
import hashlib
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import extfinal03_state as st

HERE = Path(__file__).resolve().parent
UID, GID = os.getuid(), os.getgid()
PARTS = ("var", "lib", "rel", "extfinal03")


class Tree:
    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        p = Path(self.root)
        for part in PARTS[:-1]:
            p = p / part; p.mkdir(mode=0o755); p.chmod(0o755)
        Path(self.root).chmod(0o755)
        self.state = p / PARTS[-1]
        return self

    def init(self):
        st.init(PARTS, UID, GID, self.root)
        return self

    def verify(self, **kw):
        return st.verify(PARTS, UID, GID, self.root, **kw)

    def __exit__(self, *a):
        self.tmp.cleanup()


class StateDirectory(unittest.TestCase):
    def test_clean_init_verifies_and_creates_exact_modes(self):
        with Tree() as t:
            t.init()
            self.assertEqual(t.verify(), (st.OK, []))
            self.assertEqual(stat.S_IMODE(t.state.stat().st_mode), 0o700)
            self.assertEqual(sorted(os.listdir(t.state)), sorted(st.EXPECTED))
            for name in st.EXPECTED:
                self.assertEqual(stat.S_IMODE((t.state / name).stat().st_mode), 0o600)
                self.assertEqual((t.state / name).read_bytes(), st.EXPECTED[name])

    def test_verify_does_not_create_anything(self):
        with Tree() as t:
            before = sorted(str(p) for p in Path(t.root).rglob("*"))
            status, _ = t.verify()
            self.assertEqual(status, st.NOT_INITIALISED)
            self.assertEqual(before, sorted(str(p) for p in Path(t.root).rglob("*")))

    def test_init_is_idempotent_and_never_overwrites(self):
        with Tree() as t:
            t.init()
            (t.state / st.WEB_NAME).chmod(0o600)
            t.init()
            self.assertEqual(t.verify()[0], st.OK)
            (t.state / st.WEB_NAME).write_text("tampered")
            with self.assertRaises(SystemExit):
                t.init()                                        # existing file is kept, then verification refuses it
            self.assertEqual((t.state / st.WEB_NAME).read_text(), "tampered")

    def test_symlinked_final_directory_is_refused(self):
        with Tree() as t:
            elsewhere = Path(t.root) / "elsewhere"; elsewhere.mkdir(mode=0o700)
            t.state.symlink_to(elsewhere)
            self.assertEqual(t.verify()[0], st.UNSAFE)
            with self.assertRaises(SystemExit):
                t.init()

    def test_symlink_in_a_parent_component_is_refused(self):
        with Tree() as t:
            real = Path(t.root) / "var" / "lib" / "rel"
            moved = Path(t.root) / "var" / "lib" / "rel.real"
            real.rename(moved)
            real.symlink_to(moved)
            status, problems = t.verify()
            self.assertEqual(status, st.UNSAFE, problems)

    def test_parent_writable_by_others_is_refused(self):
        for mode in (0o777, 0o775, 0o757, 0o722):
            with Tree() as t:
                (Path(t.root) / "var" / "lib" / "rel").chmod(mode)
                status, problems = t.verify()
                self.assertEqual(status, st.UNSAFE, (oct(mode), problems))

    def test_wrong_directory_mode_is_refused(self):
        with Tree() as t:
            t.init(); t.state.chmod(0o750)
            self.assertEqual(t.verify()[0], st.UNSAFE)
            t.state.chmod(0o755)
            self.assertEqual(t.verify()[0], st.UNSAFE)

    def test_untrusted_owner_is_refused(self):
        with Tree() as t:
            t.init()
            status, _ = st.verify(PARTS, UID + 1, GID, t.root)
            self.assertEqual(status, st.UNSAFE)

    def test_file_problems_are_refused(self):
        cases = {
            "mode 0644": lambda f: f.chmod(0o644),
            "content changed": lambda f: (f.chmod(0o600), f.write_text("services: {}\n")),
            "replaced by symlink": lambda f: (f.unlink(), f.symlink_to(f.parent / "other")),
            "hard link": lambda f: os.link(f, f.parent.parent / "extra-link"),
        }
        for label, mutate in cases.items():
            with Tree() as t:
                t.init()
                mutate(t.state / st.WEB_NAME)
                self.assertEqual(t.verify()[0], st.UNSAFE, label)

    def test_unexpected_entries_are_refused(self):
        with Tree() as t:
            t.init()
            (t.state / "extra.yml").write_text("x")
            self.assertEqual(t.verify()[0], st.UNSAFE)

    def test_missing_file_is_not_initialised_not_safe(self):
        with Tree() as t:
            t.init()
            (t.state / st.WEB_NAME).unlink()
            self.assertEqual(t.verify()[0], st.NOT_INITIALISED)

    def test_init_refuses_when_the_top_parents_are_missing_or_unsafe(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o755)
            with self.assertRaises(SystemExit):
                st.init(PARTS, UID, GID, tmp)                  # /var/lib must already exist: never created
        with Tree() as t:
            os.chmod(t.root, 0o777)
            with self.assertRaises(SystemExit):
                t.init()

    def test_non_owner_sees_metadata_only(self):
        with Tree() as t:
            t.init()
            self.assertEqual(t.verify(can_read_final=False)[0], st.METADATA_ONLY)



    def test_an_untraversable_parent_is_never_reported_safe(self):
        with Tree() as t:
            t.init()
            parent = Path(t.root) / "var" / "lib" / "rel"
            parent.chmod(0o600)                       # cannot be searched: the check could not look, so it must not claim 'safe'
            try:
                self.assertNotEqual(t.verify()[0], st.OK)
            finally:
                parent.chmod(0o755)





STORE = "gnibjomjfdobadlockphjiibbpmiehcj"
REPO = Path(os.environ.get("XA_REPO", str(Path(__file__).resolve().parents[3])))


class PinnedContent(unittest.TestCase):
    def test_both_files_are_pinned_and_tampering_either_is_refused(self):
        self.assertEqual(sorted(st.EXPECTED), [st.EXT_NAME, st.WEB_NAME])
        for name in st.EXPECTED:
            with Tree() as t:
                t.init()
                (t.state / name).chmod(0o600)
                (t.state / name).write_text("services: {}\n")
                self.assertEqual(t.verify()[0], st.UNSAFE, name)

    def test_extension_override_sets_exactly_one_variable_to_exactly_the_store_id(self):
        text = st.EXT_TEXT
        self.assertEqual(re.findall(r"^\s+([A-Z_]+):", text, re.M), ["EXTENSION_ALLOWED_IDS"])
        self.assertIn("""EXTENSION_ALLOWED_IDS: '["%s"]'""" % STORE, text)
        self.assertEqual(re.findall(r"[a-p]{32}", text), [STORE])
        self.assertNotIn("cglmdonbfbadfbggkpajpkjgpekhkall", text)
        for forbidden in ("HUNTER", "PEOPLE_", "OPENAI", "DRAFTING", "SECRET", "PASSWORD", "image:"):
            self.assertNotIn(forbidden, text)

    def test_web_override_pins_only_the_web_image_and_holds_no_environment(self):
        text = st.WEB_TEXT
        self.assertEqual(re.findall(r"^  ([a-z]+):\s*$", text, re.M), ["web"])
        self.assertEqual(re.findall(r"image: (\S+)", text), ["xpertapply-web:extfinal03-273f975-prod-amd64"])
        code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotIn("environment", code)
        self.assertIn("pull_policy: never", code)


class ScriptAudit(unittest.TestCase):
    def read(self, name):
        return (HERE / name).read_text()

    def test_syntax(self):
        for name in ("extfinal03-common.sh", "production-release.sh", "production-rollback.sh", "init-extfinal03-state.sh", "install-extfinal03.sh"):
            r = subprocess.run(["bash", "-n", str(HERE / name)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, name + r.stderr)

    def test_apply_needs_root_exact_confirmation_installed_copy_and_every_check(self):
        rel, rb = self.read("production-release.sh"), self.read("production-rollback.sh")
        for text, phrase in ((rel, 'CONFIRM_PHRASE="extfinal03-release-${target}"'), (rb, 'CONFIRM_PHRASE="extfinal03-rollback-${target}"')):
            self.assertIn(phrase, text)
            self.assertIn("apply must run as root", text)
            self.assertIn("(( fail == 0 && skip == 0 && state_ok ))", text)
        self.assertIn("run the INSTALLED copy under /opt/xpertapply-release", self.read("extfinal03-common.sh"))

    def test_only_one_container_is_ever_recreated_and_never_with_a_build_or_dependencies(self):
        for name in ("production-release.sh", "production-rollback.sh"):
            text = self.read(name)
            ups = re.findall(r"up -d ([^\n]*)", text)
            self.assertTrue(ups)
            for u in ups:
                self.assertIn("--no-deps --no-build", u)
                self.assertRegex(u, r"\"\$SVC\"")
            for forbidden in ("down", "docker rm", "docker stop", "docker restart", "--force-recreate", "prune", "volume"):
                self.assertNotRegex(text, r"(?m)^[^#\n]*\b" + re.escape(forbidden) + r"\b", name + ": " + forbidden)

    def test_no_user_writable_path_is_a_compose_input_and_the_env_file_is_never_edited(self):
        common = self.read("extfinal03-common.sh")
        compose_inputs = re.findall(r'(?:BASE4|ACT|IMG8|WEBIMG|EXTID)="\$\{(STATE[A-Z0-9]*)\}', common)
        self.assertEqual(sorted(set(compose_inputs)), ["STATE3", "STATE8", "STATEE"])
        for name in ("production-release.sh", "production-rollback.sh", "extfinal03-common.sh"):
            text = self.read(name)
            self.assertNotRegex(text, r">>?\s*\"?\$ENV_FILE|sed -i[^\n]*ENV_FILE|tee[^\n]*ENV_FILE")

    def test_archives_are_hash_pinned_and_the_loaded_image_id_is_rechecked(self):
        common = self.read("extfinal03-common.sh")
        self.assertIn("does not match its pinned SHA-256", common)
        self.assertIn("loaded archive did not yield the expected image id", common)
        for name in ("NEW_WEB_TAR_SHA", "OLD_WEB_TAR_SHA"):
            self.assertRegex(common, name + r'="[0-9a-f]{64}"')

    def test_nothing_secret_is_printed_and_hunter_and_drafting_are_checked_unchanged(self):
        rel = self.read("production-release.sh")
        self.assertIn("same_except_ext", rel)
        self.assertIn("drafting-not-disabled", self.read("extfinal03-common.sh"))
        for forbidden in ("printenv", "cat \"$ENV_FILE\"", "cat $ENV_FILE", "docker inspect -f '{{.Config.Env}}'", "env | "):
            self.assertNotIn(forbidden, rel)

    def test_release_checks_content_and_the_store_id_is_not_the_staging_id(self):
        rel = self.read("production-release.sh")
        for needle in ("no staging host or staging extension id", "no public install link", "extension sign-out teardown", "/support page", "NET-PROD-08 neutral rate-limit wording is preserved"):
            self.assertIn(needle, rel)
        common = self.read("extfinal03-common.sh")
        self.assertIn('STORE_ID="gnibjomjfdobadlockphjiibbpmiehcj"', common)
        self.assertNotIn("cglmdonbfbadfbggkpajpkjgpekhkall\"", common.split("redirect_check")[0])

    def test_installer_installs_exactly_what_sha256sums_lists_including_itself(self):
        text = self.read("install-extfinal03.sh")
        self.assertIn("sha256sum -c --quiet SHA256SUMS", text)
        self.assertIn("awk '{print $2}' \"$SRC/SHA256SUMS\"", text)
        self.assertIn("refusing to overwrite", text)


import extfinal03_delta as delta  # noqa: E402


def _svc(image, env=None, **extra):
    d = {"image": image, "environment": env or {}}
    d.update(extra)
    return d


def _world(web_image="web:old", api_env=None, web_env=None):
    return {"services": {"api": _svc("api:1", api_env or {"HUNTER_API_KEY": "x", "PEOPLE_EMAIL_DISCOVERY_ENABLED": "true"}),
                         "web": _svc(web_image, web_env or {"NEXT_PUBLIC_API_URL": "u"}), "worker": _svc("w:1"), "redis": _svc("r:1")}}


class DeltaLogic(unittest.TestCase):
    def run_check(self, cur, tgt, target):
        return delta.check(cur, tgt, target, STORE, "web:new")

    def test_web_image_only_change_passes(self):
        self.assertEqual(self.run_check(_world(), _world("web:new"), "web")[1], [])

    def test_api_environment_adding_only_the_store_id_passes(self):
        cur = _world(); tgt = _world(); tgt["services"]["api"]["environment"]["EXTENSION_ALLOWED_IDS"] = '["%s"]' % STORE
        d, p = self.run_check(cur, tgt, "api")
        self.assertEqual((d, p), (["EXTENSION_ALLOWED_IDS"], []))

    def test_every_other_difference_fails(self):
        def api(mut):
            cur = _world(); tgt = _world(); tgt["services"]["api"]["environment"]["EXTENSION_ALLOWED_IDS"] = '["%s"]' % STORE; mut(tgt); return self.run_check(cur, tgt, "api")[1]
        self.assertTrue(api(lambda t: t["services"]["api"]["environment"].update(HUNTER_API_KEY="y")))             # touching Hunter
        self.assertTrue(api(lambda t: t["services"]["api"]["environment"].update(PEOPLE_EMAIL_DISCOVERY_ENABLED="false")))
        self.assertTrue(api(lambda t: t["services"]["api"]["environment"].update(APPLICATION_ANSWER_DRAFTING_ENABLED="true")))   # enabling drafting
        self.assertTrue(api(lambda t: t["services"]["api"]["environment"].update(EXTENSION_ALLOWED_IDS='["%s","cglmdonbfbadfbggkpajpkjgpekhkall"]' % STORE)))
        self.assertTrue(api(lambda t: t["services"]["api"]["environment"].update(EXTENSION_ALLOWED_IDS="%s" % STORE)))   # not a JSON list
        self.assertTrue(api(lambda t: t["services"]["api"].update(image="api:2")))
        self.assertTrue(api(lambda t: t["services"]["api"].update(ports=["1:1"])))
        self.assertTrue(api(lambda t: t["services"]["web"].update(image="web:new")))
        self.assertTrue(api(lambda t: t["services"]["worker"].update(image="w:2")))
        cur, tgt = _world(), _world("web:new")
        for mut in (lambda t: t["services"]["web"]["environment"].update(X="1"), lambda t: t["services"]["web"].update(ports=["1:1"]),
                    lambda t: t["services"]["api"]["environment"].update(Z="1"), lambda t: t["services"]["redis"].update(image="r:2")):
            t2 = json.loads(json.dumps(tgt)); mut(t2)
            self.assertTrue(self.run_check(cur, t2, "web")[1])
        self.assertTrue(delta.check(cur, _world("web:other"), "web", STORE, "web:new")[1])   # wrong image reference

    def test_drift_between_render_and_the_running_container_is_refused(self):
        cur = _world(); tgt = _world("web:new")
        self.assertTrue(delta.check(cur, tgt, "web", STORE, "web:new", running_env={"NEXT_PUBLIC_API_URL": "different"})[1])
        self.assertEqual(delta.check(cur, tgt, "web", STORE, "web:new", running_env={"NEXT_PUBLIC_API_URL": "u"})[1], [])


import json  # noqa: E402
import shutil  # noqa: E402


@unittest.skipUnless(shutil.which("docker") and (REPO / "docker-compose.yml").exists(), "docker or the repository is not available")
class ComposeMergeSimulation(unittest.TestCase):
    """Renders the repository's real Compose files with the two override files (the production checkout and the NET-PROD-03 files are not
    available off-host, so the merge semantics are proven against the repository files plus the NET-PROD-08 image file)."""

    IMG8 = ("services:\n  api:\n    image: xpertapply-api:netprod08-32a7d54-prod-amd64\n    build: !reset null\n    pull_policy: never\n"
            "  web:\n    image: xpertapply-web:netprod08-32a7d54-prod-amd64\n    build: !reset null\n    pull_policy: never\n")

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()   # one project directory for every render, so build-context paths are identical

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def render(self, extra):
        if True:
            d = Path(self._tmp.name)
            for n in ("docker-compose.yml", "compose.production.yml"):
                shutil.copy(REPO / n, d / n)
            env = (REPO / ".env.example").read_text() + "\nNEXT_PUBLIC_API_URL=https://api.xpertapply.com\nNEXT_PUBLIC_SITE_URL=https://xpertapply.com\n"
            (d / ".env").write_text(env)
            files = [d / "docker-compose.yml", d / "compose.production.yml"]
            (d / "img8.yml").write_text(self.IMG8); files.append(d / "img8.yml")
            for name in extra:
                (d / name).write_bytes(st.EXPECTED[name]); files.append(d / name)
            cmd = ["docker", "compose", "--project-name", "xpertapply", "--project-directory", str(d), "--env-file", str(d / ".env")]
            for f in files:
                cmd += ["-f", str(f)]
            r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True)
            if r.returncode:
                self.skipTest("compose could not render here: " + r.stderr[:200])
            return json.loads(r.stdout)

    def test_web_override_changes_only_the_web_image(self):
        cur, tgt = self.render([]), self.render([st.WEB_NAME])
        d, p = delta.check(cur, tgt, "web", STORE, "xpertapply-web:extfinal03-273f975-prod-amd64")
        self.assertEqual((d, p), ([], []))
        self.assertEqual(tgt["services"]["api"], cur["services"]["api"])

    def test_extension_override_adds_exactly_one_api_variable_with_the_exact_value(self):
        cur, tgt = self.render([]), self.render([st.EXT_NAME])
        d, p = delta.check(cur, tgt, "api", STORE, "x")
        self.assertEqual((d, p), (["EXTENSION_ALLOWED_IDS"], []))
        self.assertEqual(tgt["services"]["api"]["environment"]["EXTENSION_ALLOWED_IDS"], '["%s"]' % STORE)
        self.assertEqual(tgt["services"]["web"], cur["services"]["web"])

    def test_both_overrides_compose_in_either_order_of_application(self):
        both = self.render([st.WEB_NAME, st.EXT_NAME])
        self.assertEqual(both["services"]["web"]["image"], "xpertapply-web:extfinal03-273f975-prod-amd64")
        self.assertEqual(both["services"]["api"]["environment"]["EXTENSION_ALLOWED_IDS"], '["%s"]' % STORE)
        self.assertEqual(both["services"]["api"]["image"], "xpertapply-api:netprod08-32a7d54-prod-amd64")


if __name__ == "__main__":
    unittest.main()
