# Staging DNS and HTTPS (XA-STG0)

Nothing here has been run. Do not change production nginx files; do not run certbot until the DNS step is verified.

## DNS records (create at the DNS provider)
| Name | Type | Value | Note |
|---|---|---|---|
| `staging.xpertapply.com` | A | `<VPS public IPv4>` | add `AAAA` only if production has IPv6 working |
| `api-staging.xpertapply.com` | A | `<VPS public IPv4>` | same address as production if sharing the VPS |

Use a low TTL (300) while testing. Verify before continuing:
`dig +short staging.xpertapply.com api-staging.xpertapply.com` returns the VPS address.
Do not create wildcard records.

## Prerequisites on the host
* Ports 80 and 443 already reach nginx (production already does).
* certbot installed (`certbot --version`), webroot `/var/www/certbot` exists and is readable by nginx.
* Staging API healthy on `127.0.0.1:8021` (RUNBOOK section 10) before exposing it.

## Provisioning (nginx edits are manual; each reload is checked with `nginx -t` first)
```bash
# 1. HTTP bootstrap vhosts (answer only the ACME challenge, return 404 otherwise)
sudo cp infra/staging/nginx/api-staging.xpertapply.com.http-bootstrap.conf /etc/nginx/sites-available/api-staging.xpertapply.com
sudo cp infra/staging/nginx/staging.xpertapply.com.http-bootstrap.conf     /etc/nginx/sites-available/staging.xpertapply.com
sudo ln -s /etc/nginx/sites-available/api-staging.xpertapply.com /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/staging.xpertapply.com     /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 2. Certificates, one per host (no wildcard, no changes to production certificates)
sudo certbot certonly --webroot -w /var/www/certbot -d api-staging.xpertapply.com --cert-name api-staging.xpertapply.com
sudo certbot certonly --webroot -w /var/www/certbot -d staging.xpertapply.com     --cert-name staging.xpertapply.com
# Use --dry-run first to confirm the challenge path works without consuming rate limit.

# 3. Replace the bootstrap files with the TLS vhosts
sudo cp infra/staging/nginx/api-staging.xpertapply.com.conf /etc/nginx/sites-available/api-staging.xpertapply.com
sudo cp infra/staging/nginx/staging.xpertapply.com.conf     /etc/nginx/sites-available/staging.xpertapply.com
sudo nginx -t && sudo systemctl reload nginx
```
Only the two staging files are touched. `nginx -t` must pass before every reload; if it fails, remove the new
symlinks and reload again.

## Verify
```bash
curl -sSI http://api-staging.xpertapply.com | head -3          # 301 to https
curl -fsS https://api-staging.xpertapply.com/healthz           # 200
openssl s_client -connect api-staging.xpertapply.com:443 -servername api-staging.xpertapply.com </dev/null 2>/dev/null | openssl x509 -noout -subject -dates
curl -sSI -H 'Host: api.xpertapply.com' https://api-staging.xpertapply.com/ -k | head -1   # must NOT be production content
```
Renewal: certbot's existing timer covers new certificates; confirm with `sudo certbot renew --dry-run`.

## Removal
Remove the two symlinks, `nginx -t`, reload, then `sudo certbot delete --cert-name <host>` for each staging name only.
