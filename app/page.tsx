import { authorized } from '@/lib/auth';
import { cameraRemoteEnabled } from '@/lib/camera-remote-feature';
import Studio from './studio';
export const dynamic='force-dynamic';
export default async function Home() {return <Studio initialAuthenticated={await authorized()} cameraRemoteEnabled={cameraRemoteEnabled(process.env.NODE_ENV,process.env.CAMERA_REMOTE_TEST_ENABLE)} />;}
