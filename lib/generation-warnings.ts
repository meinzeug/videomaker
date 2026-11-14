/** Old projects may contain arbitrary extra model fields; render only short text. */
export function generationWarnings(value:unknown):string[] {
 return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'&&item.trim().length>0).slice(0,10).map(item=>item.slice(0,1000)):[];
}
