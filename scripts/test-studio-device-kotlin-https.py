#!/usr/bin/env python3
"""Run a local pinned Kotlin/Node HTTPS test; no device or production network."""
import glob
import os
from pathlib import Path
import subprocess
import tempfile

WORK=Path('/home/dennis/.videomaker-studio-device-http-fixture')
ANDROID=Path('/home/dennis/.kontraprompter-studio-device-identity')
CACHE='/home/dennis/.gradle/caches/modules-2/files-2.1/'
MODULES=WORK/'node_modules';SOURCE=Path('/home/dennis/.videomaker-auth-transaction-fence/node_modules')
def jar(spec):
    found=glob.glob(CACHE+spec+'/*/*.jar')
    if len(found)!=1:raise RuntimeError('Missing or ambiguous dependency: '+spec)
    return found[0]

def main():
    if Path(__file__).resolve().parents[1]!=WORK:raise RuntimeError('Unexpected worktree')
    dependencies=[jar(x) for x in ('org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.20','org.jetbrains.kotlin/kotlin-stdlib/2.2.20',
     'org.jetbrains.kotlin/kotlin-script-runtime/2.2.20','org.jetbrains.kotlin/kotlin-reflect/1.6.10',
     'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.20','org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0','org.jetbrains/annotations/13.0')]
    gson=jar('com.google.code.gson/gson/2.11.0')
    out=Path(tempfile.mkdtemp(prefix='studio-device-https-client.',dir='/dev/shm'));print('Synthetic output:',out,flush=True)
    created=False
    try:
        if not MODULES.exists() and not MODULES.is_symlink():os.symlink(SOURCE,MODULES);created=True
        elif not MODULES.is_symlink() or Path(os.readlink(MODULES))!=SOURCE:raise RuntimeError('Unexpected dependencies')
        source=ANDROID/'app/src/main/java/de/kontrakurs/kontraprompter/cloud/StudioDeviceTranscript.kt'
        experiment=ANDROID/'experiments/studio-device-login'
        subprocess.run(['java','-Xmx160m','-XX:ActiveProcessorCount=1','-cp',os.pathsep.join(dependencies),
         'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',os.pathsep.join([dependencies[1],gson]),
         '-d',str(out),str(source),str(experiment/'DeviceHttpsFixture.kt')],check=True,timeout=120)
        env={**os.environ,'STUDIO_DEVICE_HTTPS_JVM_CLASSES':str(out),'STUDIO_DEVICE_HTTPS_STDLIB':dependencies[1],'STUDIO_DEVICE_HTTPS_GSON':gson}
        subprocess.run(['node','--max-old-space-size=128','--test','tests/studio-device-kotlin-https.test.mjs'],cwd=WORK,env=env,check=True,timeout=45)
    finally:
        if created and MODULES.is_symlink() and Path(os.readlink(MODULES))==SOURCE:MODULES.unlink()
        files=[p for p in out.rglob('*') if p.is_file() or p.is_symlink()]
        dirs=('de/kontrakurs/kontraprompter/cloud','de/kontrakurs/kontraprompter','de/kontrakurs','de','META-INF')
        allowed=lambda p: p==out/'META-INF/main.kotlin_module' or (p.parent==out/'de/kontrakurs/kontraprompter/cloud' and p.name.endswith('.class') and (p.name.startswith('Device') or p.name.startswith('StudioDeviceTranscript')))
        if files and all((out/rel).is_dir() and not (out/rel).is_symlink() for rel in dirs) and all(not p.is_symlink() and allowed(p) for p in files):
            for p in files:p.unlink()
            for rel in dirs:(out/rel).rmdir()
            out.rmdir()
        else:print('Partial or unexpected fixture output retained for review:',out,flush=True)

if __name__=='__main__':main()
