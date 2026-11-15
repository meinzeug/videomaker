#!/usr/bin/env python3
"""Disposable camera test only. Never run against a live server or regular package."""
import hashlib, os, re, select, shutil, signal, socket, socketserver, ssl, subprocess, sys, tempfile, threading, time, xml.etree.ElementTree as ET
from pathlib import Path

HOME=Path('/home/dennis'); WORK=HOME/'.videomaker-camera-device-e2e'; ROOT=Path(__file__).resolve().parents[1]
PKI=Path('/tmp/camera-loopback-pki-zxeuu3l9'); NEXT_PORT=0; PROXY_PORT=0; DEVICE_PORT=3395
APP='de.kontrakurs.kontraprompter.journalfixture'; TEST=APP+'.test'
NEEDLE=b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false };"
REPLACE=b"const config: NextConfig = { serverExternalPackages: ['better-sqlite3'], poweredByHeader: false, turbopack: { root: '/home/dennis' } };"

class Tunnel(socketserver.BaseRequestHandler):
 def handle(self):
  with socket.create_connection(('127.0.0.1',NEXT_PORT),timeout=10) as upstream:
   sockets=[self.request,upstream]
   while True:
    buffered = [self.request] if isinstance(self.request, ssl.SSLSocket) and self.request.pending() else []
    readable=buffered or select.select(sockets,[],[],35)[0]
    if not readable:return
    for source in readable:
     data=source.recv(32768)
     if not data:return
     (upstream if source is self.request else self.request).sendall(data)
class TLSserver(socketserver.ThreadingTCPServer):
 allow_reuse_address=False; daemon_threads=True
 def get_request(self):
  sock,addr=super().get_request()
  try:
   sock.settimeout(5)
   secured=self.context.wrap_socket(sock,server_side=True);secured.settimeout(None)
   return secured,addr
  except Exception:sock.close();raise

def run(*args, **kwargs):return subprocess.run(args,check=True,text=True,capture_output=True,**kwargs).stdout

def ensure_free(port):
 with socket.socket() as s:s.bind(('127.0.0.1',port))

def reverse_list(serial):return run('adb','-s',serial,'reverse','--list').strip().splitlines()

def interrupted(signum,frame):raise InterruptedError(f'interrupted by signal {signum}')

def install(serial,apk,package):
 cmd=['adb','-s',serial,'install']+(['-t'] if package==TEST else [])+[str(apk)]
 p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 try:
  if serial=='HEHU4TQSINOJEQG6':
   deadline=time.monotonic()+55
   while p.poll() is None and time.monotonic()<deadline:
    raw=subprocess.run(['adb','-s',serial,'exec-out','uiautomator','dump','/dev/tty'],text=True,capture_output=True,timeout=12).stdout
    a,b=raw.find('<?xml'),raw.rfind('</hierarchy>')
    if a>=0 and b>=0:
     nodes=list(ET.fromstring(raw[a:b+len('</hierarchy>')]).iter('node'));texts={n.get('text','') for n in nodes}
     if 'Diese App über USB installieren?' in texts and package in texts:
      buttons=[n for n in nodes if n.get('text')=='Installieren']
      if len(buttons)==1:
       rect=list(map(int,re.findall(r'\d+',buttons[0].get('bounds',''))));assert len(rect)==4 and rect[2]>rect[0] and rect[3]>rect[1]
       run('adb','-s',serial,'shell','input','tap',str((rect[0]+rect[2])//2),str((rect[1]+rect[3])//2));break
    time.sleep(.3)
  output=p.communicate(timeout=45)[0]
  if p.returncode or 'Success' not in output:raise RuntimeError(f'Fixture install failed for {package}: {output.strip()}')
 finally:
  if p.poll() is None:p.terminate();p.wait(timeout=5)

def main():
 global NEXT_PORT, PROXY_PORT
 if ROOT!=WORK or len(sys.argv)!=4:raise RuntimeError('Only dedicated fixture worktree, serial and two APKs are allowed')
 serial,app_arg,test_arg=sys.argv[1:];app=Path(app_arg).resolve();test=Path(test_arg).resolve()
 if serial not in ('HEHU4TQSINOJEQG6','R5CR60Q07YN'):raise RuntimeError('Unexpected device')
 if shutil.disk_usage(HOME).free < 512*1024*1024 or shutil.disk_usage('/tmp').free < 256*1024*1024:raise RuntimeError('Insufficient disk reserve')
 for path,key in ((app,'CAMERA_FIXTURE_APP_SHA256'),(test,'CAMERA_FIXTURE_TEST_SHA256')):
  if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=os.environ.get(key):raise RuntimeError('APK digest mismatch')
 aapt=str(HOME/'Android/Sdk/build-tools/35.0.0/aapt')
 for path,expected in ((app,APP),(test,TEST)):
  badging=run(aapt,'dump','badging',str(path))
  if not re.search(r"^package: name='"+re.escape(expected)+r"'",badging,re.M):raise RuntimeError('Unexpected APK package')
 manifest=run(aapt,'dump','xmltree',str(test),'AndroidManifest.xml')
 if ('android:targetPackage' not in manifest or f'\"{APP}\"' not in manifest or 'android.test.InstrumentationTestRunner' not in manifest):raise RuntimeError('Unexpected instrumentation target')
 with socket.socket() as candidate:
  candidate.bind(('127.0.0.1',0));NEXT_PORT=candidate.getsockname()[1]
 ensure_free(NEXT_PORT)
 before=reverse_list(serial);print('ADB reverse before:',before,flush=True)
 if any(('tcp:'+str(DEVICE_PORT)) in line.split() for line in before):raise RuntimeError('ADB reverse port already used')
 packages=run('adb','-s',serial,'shell','pm','list','packages').splitlines()
 if 'package:'+APP in packages or 'package:'+TEST in packages:raise RuntimeError('Fixture packages already exist')
 camera=run('adb','-s','HEHU4TQSINOJEQG6','exec-out','uiautomator','dump','/dev/tty')
 if 'Aufnahme starten' not in camera or 'Aufnahme stoppen' in camera:raise RuntimeError('Recording status not safely visible')
 run('openssl','verify','-CAfile',str(PKI/'ca.pem'),str(PKI/'server.pem'))
 run('git','-C',str(WORK),'diff','--quiet','--','next.config.ts','next-env.d.ts')
 config=WORK/'next.config.ts';nextenv=WORK/'next-env.d.ts';original=config.read_bytes();original_env=nextenv.read_bytes()
 if original.count(NEEDLE)!=1:raise RuntimeError('Unexpected Next config')
 injected=original.replace(NEEDLE,REPLACE);fixture=Path(tempfile.mkdtemp(prefix='.camera-device-e2e.',dir=HOME));(fixture/'.fixture').write_text('camera-device-e2e\n')
 proc=None;server=None;thread=None;reverse=False;installed=[];preserve=False
 old_handlers={sig:signal.signal(sig,interrupted) for sig in (signal.SIGINT,signal.SIGTERM)}
 monitor_stop=threading.Event()
 def monitor_disk():
  while not monitor_stop.wait(1):
   if shutil.disk_usage(HOME).free < 384*1024*1024:
    print('Disk reserve below 384 MiB; stopping fixture.',flush=True);os.kill(os.getpid(),signal.SIGTERM);return
 monitor=threading.Thread(target=monitor_disk,daemon=True);monitor.start()
 try:
  config.write_bytes(injected)
  env=os.environ.copy();env.update(DATA_DIR=str(fixture),ADMIN_PASSWORD='camera-e2e-fixture-only',SESSION_SECRET='camera-e2e-test-only-session-secret-1234567890',VIDEOMAKER_PUBLIC_ORIGIN='https://127.0.0.1:3395',CAMERA_REMOTE_TEST_ENABLE='1',NODE_ENV='development',NODE_OPTIONS='--max-old-space-size=768')
  with (fixture/'dev.log').open('w+') as log:
   proc=subprocess.Popen(['./node_modules/.bin/next','dev','--hostname','127.0.0.1','--port',str(NEXT_PORT)],cwd=WORK,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   for _ in range(150):
    if proc.poll() is not None:raise RuntimeError('Next fixture exited')
    try:
     with socket.create_connection(('127.0.0.1',NEXT_PORT),timeout=.2):pass
     listeners=run('ss','-ltnp',f'sport = :{NEXT_PORT}')
     pids={int(value) for value in re.findall(r'pid=(\d+)',listeners)}
     if not pids or any(os.getpgid(pid)!=proc.pid for pid in pids):raise RuntimeError('Next fixture port claimed by another process')
     break
    except OSError:time.sleep(.2)
   else:raise TimeoutError('Next fixture did not start')
   server=TLSserver(('127.0.0.1',0),Tunnel);PROXY_PORT=server.server_address[1]
   server.context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);server.context.load_cert_chain(PKI/'server.pem',PKI/'server.key')
   print('Fixture ports:',NEXT_PORT,PROXY_PORT,flush=True)
   thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   # Recheck immediately before creating an ADB rule; never replace another rule.
   if reverse_list(serial)!=before:raise RuntimeError('ADB reverse rules changed during setup')
   run('adb','-s',serial,'reverse','--no-rebind',f'tcp:{DEVICE_PORT}',f'tcp:{PROXY_PORT}');reverse=True
   for apk,package in ((app,APP),(test,TEST)):
    installed.append(package) # preflight proved this exact test package absent
    install(serial,apk,package)
   result=subprocess.run(['adb','-s',serial,'shell','am','instrument','-w','-r','-e','class','de.kontrakurs.kontraprompter.camera.CameraLocalE2eTest',TEST+'/android.test.InstrumentationTestRunner'],text=True,capture_output=True,timeout=120)
   print(result.stdout,flush=True)
   if result.returncode or 'OK (1 test)' not in result.stdout or 'INSTRUMENTATION_CODE: -1' not in result.stdout:raise RuntimeError('Device fixture test failed')
 finally:
  monitor_stop.set();monitor.join(timeout=3)
  for sig,handler in old_handlers.items():signal.signal(sig,handler)
  for package in reversed(installed):
   try:
    present=run('adb','-s',serial,'shell','pm','list','packages').splitlines()
    if 'package:'+package in present:
     result=run('adb','-s',serial,'uninstall',package)
     if 'Success' not in result:raise RuntimeError(result.strip())
   except Exception as error:print('Fixture package cleanup failed:',package,error,flush=True)
  if reverse:
   try:
    current=reverse_list(serial);own=[line for line in current if f'tcp:{DEVICE_PORT}' in line.split()]
    if len(own)==1 and f'tcp:{PROXY_PORT}' in own[0].split():run('adb','-s',serial,'reverse','--remove',f'tcp:{DEVICE_PORT}')
    else:print('ADB rule changed; leaving it untouched.',flush=True)
    after=reverse_list(serial);print('ADB reverse after:',after,flush=True)
    if after!=before:print('ADB reverse rules differ from initial snapshot; inspect.',flush=True)
   except Exception as error:print('ADB cleanup failed:',error,flush=True)
  if server:server.shutdown();server.server_close()
  if thread:thread.join(timeout=5)
  if proc:
   try:os.killpg(proc.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   try:proc.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
  if config.exists() and config.read_bytes()==injected:config.write_bytes(original)
  else:preserve=True;(fixture/'original-next.config.ts').write_bytes(original)
  generated=original_env.replace(b'./.next/types/',b'./.next/dev/types/')
  if nextenv.exists() and nextenv.read_bytes() in (original_env,generated):nextenv.write_bytes(original_env)
  else:preserve=True;(fixture/'original-next-env.d.ts').write_bytes(original_env)
  if not preserve and (fixture/'.fixture').read_text()=='camera-device-e2e\n':shutil.rmtree(fixture)
  else:print('Fixture retained for inspection:',fixture,flush=True)

if __name__=='__main__':main()
