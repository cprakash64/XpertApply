import sys, os, zipfile, subprocess, hashlib
ext = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "apps", "extension")  # canonical checkout
out = sys.argv[1]
epoch = subprocess.check_output(["git","log","-1","--format=%ct"], cwd=ext, text=True).strip()
env = dict(os.environ, SOURCE_DATE_EPOCH=epoch)
subprocess.run(["node","build.mjs","--profile","production"], cwd=ext, env=env, check=True, stdout=subprocess.DEVNULL)
d = os.path.join(ext,"dist")
files = sorted(os.path.relpath(os.path.join(r,f),d) for r,_,fs in os.walk(d) for f in fs if not f.endswith(".map"))
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as z:
    for f in files:
        zi = zipfile.ZipInfo(f, (2026,1,1,0,0,0)); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = 0o644<<16
        z.writestr(zi, open(os.path.join(d,f),"rb").read())
print(hashlib.sha256(open(out,"rb").read()).hexdigest(), len(files))
