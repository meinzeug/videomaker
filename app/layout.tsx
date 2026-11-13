import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Kontrakurs Studio',description:'Recherche, Skripte und Teleprompter für Kontrakurs.'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="de"><body>{children}</body></html>;}
