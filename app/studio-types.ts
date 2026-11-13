import type { ResearchReport } from '@/lib/research';
export type Source={title:string;url:string;source:string;date:string;description:string};
export type Pack={id:string;created_at:string;title:string;angle:string;sources:Source[]};
export type Project={id:string;title:string;created_at:string;sources:Source[];content:{titles:string[];thumbnail:string;broll:string[];script:string;research?:ResearchReport;image_mode?:'render'|'descriptions'}};
