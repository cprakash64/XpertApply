import json, secrets, time, requests
A="https://api-staging.xpertapply.com"; t=int(time.time())
acc={}
for n in ("a","b"):
    email=f"xa-50c-{n}-{t}@mailbox.test-domain.co"; pw=secrets.token_urlsafe(14)
    r=requests.post(f"{A}/auth/signup",json={"email":email,"password":pw},timeout=30)
    print(n,r.status_code)
    acc[n]={"email":email,"password":pw,"token":r.json().get("access_token")}
json.dump(acc,open("accounts.json","w"))
h={"Authorization":"Bearer "+acc["a"]["token"]}
r=requests.get(f"{A}/jobs",headers=h,timeout=30); print("jobs",r.status_code)
d=r.json(); items=d if isinstance(d,list) else d.get("jobs") or d.get("items") or d
print(type(d), list(d)[:6] if isinstance(d,dict) else len(d))
if isinstance(items,list): print(len(items), [(j.get("id"),j.get("company"),j.get("title")) for j in items[:5]])
