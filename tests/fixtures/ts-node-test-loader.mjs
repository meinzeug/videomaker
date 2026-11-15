/** Test-only extension bridge for source TypeScript; no production loader. */
export async function resolve(specifier,context,nextResolve){
 try{return await nextResolve(specifier,context);}
 catch(error){
  if(error?.code!=='ERR_MODULE_NOT_FOUND')throw error;
  if(specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return nextResolve(specifier+'.ts',context);
  if(specifier==='next/headers')return nextResolve('next/headers.js',context);
  throw error;
 }
}
