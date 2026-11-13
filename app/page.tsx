import { authorized } from '@/lib/auth';
import Studio from './studio';
export const dynamic='force-dynamic';
export default async function Home() {return <Studio initialAuthenticated={await authorized()} />;}
