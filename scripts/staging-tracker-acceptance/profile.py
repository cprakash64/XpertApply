import json, requests
A="https://api-staging.xpertapply.com"; acc=json.load(open("accounts.json"))
profile={"full_name":"Xa Fifty Cee","phone":"602-555-0100","location_city":"Phoenix","location_state":"AZ","location_country":"United States","work_authorization":"authorized_us","target_roles":["Backend Engineer"],"target_levels":["Junior"],"preferred_locations":["United States"],"remote_preference":"remote","skills":["Python","FastAPI","PostgreSQL"]}
career={"education":[{"school":"Test University","degree":"BS"}],"experience":[{"company":"Marker Corp","title":"Engineer","bullets":["ORIGINAL-RESUME-MARKER built Python services"],"technologies":["Python"],"currently_working":True}],"projects":[],"certifications":[],"awards":[]}
for n in "ab":
    h={"Authorization":"Bearer "+acc[n]["token"]}
    for p,d in (("/profile",profile),("/profile/career",career)):
        r=requests.put(A+p,headers=h,json=d,timeout=30); print(n,p,r.status_code)
    me=requests.get(A+"/auth/me",headers=h,timeout=30); print(me.status_code, {k:v for k,v in (me.json() if me.ok else {}).items() if k in("id",)})
    acc[n]["id"]=me.json().get("id") if me.ok else None
json.dump(acc,open("accounts.json","w"))
r=requests.get(A+"/jobs",headers={"Authorization":"Bearer "+acc["a"]["token"]},timeout=30).json()["jobs"]
print([ (j["id"],j["company"]) for j in r[:8]])
