#!/usr/bin/env python3
"""Synthetic JVM/SQLite test. Never uses a device, production data or network."""
import glob
import os
from pathlib import Path
import subprocess
import tempfile

WORK = Path('/home/dennis/.videomaker-studio-device-cross-runtime')
ANDROID = Path('/home/dennis/.kontraprompter-studio-device-transcript')
CACHE = '/home/dennis/.gradle/caches/modules-2/files-2.1/'
MODULES = WORK / 'node_modules'
MODULE_SOURCE = Path('/home/dennis/.videomaker-auth-transaction-fence/node_modules')

def jar(spec):
    found = glob.glob(CACHE + spec + '/*/*.jar')
    if len(found) != 1: raise RuntimeError('Missing or ambiguous local compiler dependency: ' + spec)
    return found[0]

def main():
    if Path(__file__).resolve().parents[1] != WORK or MODULES.exists() or MODULES.is_symlink():
        raise RuntimeError('Unexpected worktree or dependency path')
    jars = [jar(spec) for spec in ('org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.20',
      'org.jetbrains.kotlin/kotlin-stdlib/2.2.20','org.jetbrains.kotlin/kotlin-script-runtime/2.2.20',
      'org.jetbrains.kotlin/kotlin-reflect/1.6.10','org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.20',
      'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0','org.jetbrains/annotations/13.0')]
    out = Path(tempfile.mkdtemp(prefix='studio-device-cross.',dir='/dev/shm'))
    print('Synthetic compiler output:',out,flush=True)
    expected = {out/'META-INF/main.kotlin_module',out/'de/kontrakurs/kontraprompter/cloud/StudioDeviceTranscript.class',
      out/'de/kontrakurs/kontraprompter/cloud/StudioDeviceSignatureFixtureKt.class'}
    linked = False
    try:
        os.symlink(MODULE_SOURCE, MODULES); linked = True
        src=ANDROID/'app/src/main/java/de/kontrakurs/kontraprompter/cloud/StudioDeviceTranscript.kt'
        fixture=ANDROID/'experiments/studio-device/StudioDeviceSignatureFixture.kt'
        subprocess.run(['java','-Xmx160m','-XX:ActiveProcessorCount=1','-cp',os.pathsep.join(jars),
          'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',jars[1],
          '-d',str(out),str(src),str(fixture)],check=True,timeout=120)
        env={**os.environ,'STUDIO_DEVICE_JVM_CLASS_DIR':str(out),'STUDIO_DEVICE_KOTLIN_STDLIB':jars[1]}
        subprocess.run(['node','--max-old-space-size=128','--test','tests/studio-device-cross-runtime.test.mjs'],cwd=WORK,env=env,check=True,timeout=45)
    finally:
        if linked and MODULES.is_symlink() and Path(os.readlink(MODULES)) == MODULE_SOURCE: MODULES.unlink()
        actual={p for p in out.rglob('*') if p.is_file() or p.is_symlink()}
        if actual == expected:
            for p in expected: p.unlink()
            for rel in ('de/kontrakurs/kontraprompter/cloud','de/kontrakurs/kontraprompter','de/kontrakurs','de','META-INF'):
                (out/rel).rmdir()
            out.rmdir()
        else:
            print('Unexpected/partial test output retained for review:',out,flush=True)

if __name__ == '__main__': main()
