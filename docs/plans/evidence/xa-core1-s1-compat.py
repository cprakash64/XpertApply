from fastapi.testclient import TestClient
from app.main import app
c=TestClient(app)
r=c.post("/auth/signup",json={"email":"compat@mailbox.test-domain.co","password":"password123"}); print("signup",r.status_code)
t=r.json()["access_token"]; h={"Authorization":f"Bearer {t}"}
print("me",c.get("/auth/me",headers=h).status_code)
l=c.post("/auth/login",json={"email":"compat@mailbox.test-domain.co","password":"password123"}); print("login",l.status_code)
print("profile",c.get("/profile",headers=h).status_code)
print("readyz",c.get("/readyz").status_code)
