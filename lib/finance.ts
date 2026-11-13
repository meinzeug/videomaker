/** Draft cash-flow entries, not a tax calculation or a double-entry ledger. */
export const MAX_AMOUNT_CENTS = 9_999_999_999;
export type FinanceDirection = 'income'|'expense';
export type FinanceEntry = {
 sequence:number; id:string; kind:'entry'|'reversal'; direction:FinanceDirection;
 amountCents:number; occurredOn:string; description:string; counterparty:string;
 reference:string; channelId:string|null; channelName:string|null; channelPlatform:string|null;
 createdAt:string; reversedEntryId:string|null; reversalReason:string|null; reversed:boolean;
};
export type FinanceDraft = {id:string;direction:FinanceDirection;amountCents:number;occurredOn:string;description:string;counterparty:string;reference:string;channelId:string|null};
export type FinanceReversal = {id:string;entryId:string;reason:string};
export const MAX_FINANCE_DOCUMENT_BYTES=10*1024*1024;
export const MAX_FINANCE_DOCUMENTS_PER_ENTRY=50;
export const MAX_FINANCE_DOCUMENT_TOTAL_BYTES=512*1024*1024;
export type FinanceDocument={id:string;entryId:string;originalName:string;size:number;sha256:string;createdAt:string};
export type FinanceSettingsDraft={id:string;effectiveOn:string;taxRegime:'regular'|'small_business';fiscalMode:'calendar'|'different';fiscalStartMonth:number;fiscalStartDay:number;reason:string};
export type FinanceSettingsEvent=FinanceSettingsDraft & {sequence:number;createdAt:string};

/** The name is metadata only; no user-supplied name is used as a filesystem path. */
export function validFinanceDocumentName(value:unknown):value is string {
 if(typeof value!=='string'||value.length===0||value.length>180||value.trim().length===0||
  /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(value)||value==='.'||value==='..')return false;
 try{encodeURIComponent(value);return true;}catch{return false;}
}

export function isFinanceId(value:unknown):value is string {
 return typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function parseEuroCents(value:string):number|null {
 const match=/^(0|[1-9]\d{0,7})(?:[,.](\d{1,2}))?$/.exec(value.trim());
 if(!match)return null;
 const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents>0&&cents<=MAX_AMOUNT_CENTS?cents:null;
}
function validDate(value:unknown):value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const [year,month,day]=value.split('-').map(Number);
 if(year<1900||year>9999)return false;
 const date=new Date(Date.UTC(year,month-1,day));
 return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}
function boundedText(value:unknown,label:string,max:number,required:boolean):string {
 if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${label} ist ungültig.`);
 const text=value.trim();
 if((required&&!text)||text.length>max||/[\u0000-\u001f\u007f]/.test(text))throw new Error(`${label} ist ungültig.`);
 return text;
}
export function parseFinanceDraft(input:unknown):FinanceDraft {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültiger Eintrag.');
 const item=input as Record<string,unknown>;
 if(!isFinanceId(item.id))throw new Error('Ungültige Eintrags-ID.');
 if(item.direction!=='income'&&item.direction!=='expense')throw new Error('Art des Eintrags ist ungültig.');
 if(!Number.isSafeInteger(item.amountCents)||Number(item.amountCents)<=0||Number(item.amountCents)>MAX_AMOUNT_CENTS)throw new Error('Betrag ist ungültig.');
 if(!validDate(item.occurredOn))throw new Error('Datum ist ungültig.');
 if(item.channelId!==null && !isFinanceId(item.channelId))throw new Error('Kanal ist ungültig.');
 return {id:item.id,direction:item.direction,amountCents:Number(item.amountCents),occurredOn:item.occurredOn,description:boundedText(item.description,'Beschreibung',250,true),counterparty:boundedText(item.counterparty,'Gegenpartei',160,false),reference:boundedText(item.reference,'Belegreferenz',160,false),channelId:item.channelId as string|null};
}
export function parseFinanceReversal(input:unknown):FinanceReversal {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültige Stornierung.');
 const item=input as Record<string,unknown>;
 if(!isFinanceId(item.id)||!isFinanceId(item.entryId)||item.id===item.entryId)throw new Error('Ungültige Eintrags-ID.');
 return {id:item.id,entryId:item.entryId,reason:boundedText(item.reason,'Stornogrund',250,true)};
}

/** Settings are recorded as supplied; their tax and legal effect is not calculated. */
export function parseFinanceSettings(input:unknown):FinanceSettingsDraft {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Ungültige Konfiguration.');
 const item=input as Record<string,unknown>;
 if(!isFinanceId(item.id)||!validDate(item.effectiveOn))throw new Error('ID oder Gültigkeitsdatum ist ungültig.');
 if(item.taxRegime!=='regular'&&item.taxRegime!=='small_business')throw new Error('Bitte eine Umsatzsteuer-Regelung auswählen.');
 if(item.fiscalMode!=='calendar'&&item.fiscalMode!=='different')throw new Error('Bitte die Art des Geschäftsjahres auswählen.');
 if(!Number.isInteger(item.fiscalStartMonth)||!Number.isInteger(item.fiscalStartDay))throw new Error('Beginn des Geschäftsjahres ist ungültig.');
 const month=Number(item.fiscalStartMonth),day=Number(item.fiscalStartDay);
 if(month<1||month>12||day<1||day>31||!validDate(`2025-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`))throw new Error('Beginn muss jedes Jahr ein gültiges Datum sein.');
 if(item.fiscalMode==='calendar'&&(month!==1||day!==1))throw new Error('Das Kalenderjahr beginnt am 1. Januar.');
 if(item.fiscalMode==='different'&&month===1&&day===1)throw new Error('Für ein abweichendes Geschäftsjahr einen anderen Beginn auswählen.');
 return {id:item.id,effectiveOn:item.effectiveOn,taxRegime:item.taxRegime,fiscalMode:item.fiscalMode,fiscalStartMonth:month,fiscalStartDay:day,reason:boundedText(item.reason,'Begründung',250,true)};
}
