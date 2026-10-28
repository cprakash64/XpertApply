"""Controlled SMTP sink: accepts mail on 127.0.0.1:2525 and writes each message to ./mail/*.eml. Delivers nowhere."""
import os, socketserver, sys, time
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
class H(socketserver.StreamRequestHandler):
    def handle(self):
        w=lambda s:self.wfile.write((s+"\r\n").encode()); w("220 sink ESMTP")
        data=False; lines=[]; rcpt=[]
        for raw in self.rfile:
            l=raw.decode(errors="replace").rstrip("\r\n")
            if data:
                if l==".":
                    data=False; n=f"{int(time.time()*1000)}.eml"
                    open(os.path.join(OUT,n),"w").write("\n".join(lines)+"\n"); w("250 queued")
                else: lines.append(l[1:] if l.startswith("..") else l)
                continue
            v=l.split(" ",1)[0].upper()
            if v in("EHLO","HELO"): w("250 sink")
            elif v=="DATA": data=True; lines=[]; w("354 go")
            elif v=="QUIT": w("221 bye"); return
            else: w("250 ok")
class S(socketserver.ThreadingTCPServer): allow_reuse_address=True; daemon_threads=True
S(("127.0.0.1",2525),H).serve_forever()
