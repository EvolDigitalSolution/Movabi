from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parent/'wallet-isolated-ui'
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  path=self.path.split('?',1)[0]
  if path in ['/driver-wallet-sandbox','/driver-topup-return']:name='wallet.html'
  elif path.startswith('/_vaydu-wallet/'):name=path.rsplit('/',1)[-1]
  elif path=='/driver':
   body=b'<h1>Existing Driver Hub</h1><script src="/_vaydu-wallet/entry.js"></script>';self.send_response(200);self.end_headers();self.wfile.write(body);return
  else:self.send_error(404);return
  if name not in ['wallet.html','wallet.js','wallet.css','entry.js']:self.send_error(404);return
  self.send_response(200);self.send_header('Content-Type',{'html':'text/html','js':'text/javascript','css':'text/css'}[name.rsplit('.',1)[-1]]);self.end_headers();self.wfile.write((ROOT/name).read_bytes())
 def log_message(self,*args):pass
ThreadingHTTPServer(('127.0.0.1',3789),Handler).serve_forever()
