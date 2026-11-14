import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { authMiddleware, readMiddleware } from "../middleware.ts";
import { UserError } from "../errors.ts";
import { guardVideomakerSession } from "../videomaker-session.ts";
import { agencyLinksVersion, listAgencyLinks, replaceAgencyLinks } from "../videomaker-agency-links.ts";
import { verifyAgencyTicket } from "../videomaker-catalog-tickets.ts";

const subject=z.object({kind:z.enum(["document","invoice","journal"]),id:z.uuid().transform(value=>value.toLowerCase())});
// Disabled until cross-database logout fencing and an end-to-end security review are complete.
const released=false;
const configured=()=>released && process.env.HABEN_VIDEOMAKER_SESSION_GUARD==="required" && (process.env.HABEN_AGENCY_CATALOG_SECRET?.length??0)>=32;

function videomakerCookie(headers: Headers): string | null {
  const values=(headers.get("cookie")??"").split(";").map(value=>value.trim()).filter(value=>value.startsWith("kontrakurs_session="));
  if(values.length!==1||!/^kontrakurs_session=[A-Za-z0-9_.-]{1,512}$/.test(values[0]!))return null;
  return values[0]!.slice("kontrakurs_session=".length);
}

export const getVideomakerAgencyLinks = createServerFn({method:"GET"})
  .middleware([readMiddleware]).validator(subject)
  .handler(async ({data}) => {
    if(!configured())return {enabled:false,items:[],version:null};
    const items=await listAgencyLinks(data);return {enabled:true,items,version:agencyLinksVersion(items)};
  });

export const saveVideomakerAgencyLinks = createServerFn({method:"POST"})
  .middleware([authMiddleware]).validator(z.object({subject,version:z.string().regex(/^[a-f0-9]{64}$/),tickets:z.array(z.string().max(2048)).max(100)}))
  .handler(async ({data,context}) => {
    if(!configured())throw new UserError("Die Videomaker-Agenturzuordnung ist noch nicht eingerichtet.");
    const secret=process.env.HABEN_AGENCY_CATALOG_SECRET!,headers=getRequestHeaders(),cookie=videomakerCookie(headers);
    if(!cookie)throw new UserError("Bitte erneut bei Videomaker anmelden.");
    const selected=data.tickets.map(ticket=>verifyAgencyTicket(secret,cookie,ticket,Date.now()));
    if(selected.some(item=>item===null))throw new UserError("Die Katalogauswahl ist abgelaufen. Bitte erneut laden.");
    const version=await replaceAgencyLinks(context.user.id,data.subject,selected.filter(item=>item!==null),data.version,async()=>{
      if(data.tickets.some(ticket=>verifyAgencyTicket(secret,cookie,ticket,Date.now())===null))return false;
      const request=new Request("http://127.0.0.1/videomaker-agency-recheck",{method:"POST",headers});
      return await guardVideomakerSession(request)===null;
    });
    return {ok:true,version};
  });
