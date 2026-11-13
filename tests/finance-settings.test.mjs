import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import Database from 'better-sqlite3';
import {parseFinanceSettings} from '../lib/finance.ts';
import {FinanceConflict} from '../lib/finance-store.ts';
registerHooks({resolve(specifier,context,next){if(context.parentURL?.endsWith('/lib/finance-settings.ts')&&specifier==='./finance-store')return next('./finance-store.ts',context);return next(specifier,context);}});
const {ensureFinanceSettingsSchema,createFinanceSettings,listFinanceSettings}=await import('../lib/finance-settings.ts');
const id='12c3267c-c343-41d1-8245-2a88107e7213';
const secondId='22c3267c-c343-41d1-8245-2a88107e7213';
const calendar={id,effectiveOn:'2026-01-01',taxRegime:'regular',fiscalMode:'calendar',fiscalStartMonth:1,fiscalStartDay:1,reason:'Ersteinrichtung'};
test('settings require an explicit tax regime and valid financial-year start',()=>{
 assert.equal(parseFinanceSettings(calendar).taxRegime,'regular');
 assert.equal(parseFinanceSettings({...calendar,taxRegime:'small_business',fiscalMode:'different',fiscalStartMonth:4,fiscalStartDay:1}).fiscalStartMonth,4);
 for(const patch of [{taxRegime:''},{taxRegime:'both'},{fiscalMode:''},{fiscalMode:'calendar',fiscalStartMonth:4},{fiscalMode:'different'},{fiscalMode:'different',fiscalStartMonth:2,fiscalStartDay:29},{fiscalMode:'different',fiscalStartMonth:4,fiscalStartDay:31},{effectiveOn:'2026-02-29'},{reason:' '}])assert.throws(()=>parseFinanceSettings({...calendar,...patch}));
});
test('settings changes are append-only, idempotent and preserve earlier declarations',()=>{
 const d=new Database(':memory:');ensureFinanceSettingsSchema(d);
 const first=parseFinanceSettings(calendar);assert.equal(createFinanceSettings(d,first,'2026-01-01T00:00:00Z').created,true);
 assert.equal(createFinanceSettings(d,first,'2026-01-01T01:00:00Z').created,false);
 assert.throws(()=>createFinanceSettings(d,{...first,taxRegime:'small_business'},'2026-01-01T01:00:00Z'),FinanceConflict);
 const second=parseFinanceSettings({...calendar,id:secondId,taxRegime:'small_business',fiscalMode:'different',fiscalStartMonth:4,fiscalStartDay:1,reason:'Neue Angabe'});
 assert.equal(createFinanceSettings(d,second,'2026-02-01T00:00:00Z').created,true);
 const page=listFinanceSettings(d,null,1);assert.equal(page.events[0].id,secondId);assert.equal(listFinanceSettings(d,page.nextBefore,1).events[0].id,id);
 assert.throws(()=>d.prepare('UPDATE finance_settings_events SET tax_regime=? WHERE id=?').run('regular',secondId),/cannot be updated/);
 assert.throws(()=>d.prepare('DELETE FROM finance_settings_events WHERE id=?').run(id),/cannot be deleted/);d.close();
});
