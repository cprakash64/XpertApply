import json, requests, zipfile, io, re, hashlib
A="https://api-staging.xpertapply.com"; acc=json.load(open("accounts.json"))
ha={"Authorization":"Bearer "+acc["a"]["token"]}; hb={"Authorization":"Bearer "+acc["b"]["token"]}
T={k:v["tracker"] for k,v in json.load(open("fixture.json")).items()}
trk=requests.get(A+"/jobs/tracker/all",headers=ha,timeout=30).json()["applications"]
mine={t["id"]:t for t in trk}
for n,i in T.items():
    t=mine[i]; print("TRACKER",n,i,t.get("documents_availability"),t.get("documents_unavailable_reason"),
        {k:(None if v is None else {kk:vv for kk,vv in v.items() if kk in("download_path","frozen","association_basis")}) for k,v in t["documents"].items()})
print("leak-check:", bool(re.search(r"file_path|/app/|/generated|uploads|\.pdf\"|\.docx\"", json.dumps(trk))))
def text(r,fmt):
    if fmt=="pdf":
        import pypdf; return "\n".join(p.extract_text() for p in pypdf.PdfReader(io.BytesIO(r.content)).pages)
    z=zipfile.ZipFile(io.BytesIO(r.content)); x=z.read("word/document.xml").decode(); return re.sub(r"<[^>]+>"," ",x)
def dl(name,kind,fmt="pdf",h=ha,tid=None):
    r=requests.get(f"{A}/jobs/tracker/{tid or T[name]}/documents/{kind}",params={"fmt":fmt},headers=h,timeout=60); return r
for name in ("frozen","historical","resume_only"):
  for kind in ("resume","cover-letter"):
    for fmt in ("pdf","docx"):
        r=dl(name,kind,fmt); ct=r.headers.get("content-type"); cd=r.headers.get("content-disposition")
        magic=r.content[:4]; ok_magic = magic==b"%PDF" if fmt=="pdf" else magic[:2]==b"PK"
        tx=text(r,fmt) if r.status_code==200 else ""
        print(f"{name:11} {kind:12} {fmt:4} {r.status_code} {len(r.content):6}B magic_ok={ok_magic} ct={ct} cd={cd} orig={'ORIGINAL-RESUME-MARKER' in tx or 'FROZEN-COVER' in tx} edited={'EDITED-AFTER-FREEZE' in tx} cc={r.headers.get('cache-control')} body={'' if r.status_code==200 else r.text[:80]}")
print("--- negative cases")
for label,r in {
 "ambiguous resume":dl("ambiguous","resume"),"ambiguous cover":dl("ambiguous","cover-letter"),
 "none resume":dl("none","resume"),"none cover":dl("none","cover-letter"),
 "bad kind":dl("frozen","passport"),"bad fmt txt":dl("frozen","resume","txt"),"bad fmt markdown":dl("frozen","resume","markdown"),
 "unauth":dl("frozen","resume",h={}),"bad token":dl("frozen","resume",h={"Authorization":"Bearer x.y.z"}),
 "cross-account B->A frozen":dl("frozen","resume",h=hb),"B->A cover docx":dl("historical","cover-letter","docx",h=hb),
 "nonexistent id":dl("frozen","resume",tid=999999)}.items():
    print(f"{label:28} {r.status_code} {r.text[:90]!r}")
b=requests.get(A+"/jobs/tracker/all",headers=hb,timeout=30).json()["applications"]; print("B tracker count",len(b))
