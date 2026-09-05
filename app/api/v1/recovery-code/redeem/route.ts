
import {NextResponse} from "next/server";
import {guardDevApi} from "@/lib/dev-api-guard";
import {NO_STORE_HEADERS} from "@/lib/dev-api-route";
import {SESSION_COOKIE,redeemDevRecoveryCode} from "@/lib/dev-api-store";
import {normalizeRecoveryCode} from "@/lib/recovery-code";
import {isCapabilityToken} from "@/lib/capability-token";
export const dynamic="force-dynamic";
export async function POST(request:Request){
  const rejected=guardDevApi(request,true);if(rejected)return rejected;
  const body=await request.json().catch(()=>null);
  const code=typeof body?.code==="string"?normalizeRecoveryCode(body.code):null;
  if(!code || typeof body?.retrySecret!=="string" || !isCapabilityToken(body.retrySecret))return NextResponse.json({code:"INVALID_CODE",message:"Проверьте код восстановления"},{status:400,headers:NO_STORE_HEADERS});
  const result=redeemDevRecoveryCode(code,body.retrySecret);
  if(!result)return NextResponse.json({code:"INVALID_CODE",message:"Код неверен, заменён или уже использован"},{status:401,headers:NO_STORE_HEADERS});
  const response=NextResponse.json(result.me,{headers:NO_STORE_HEADERS});
  response.cookies.set(SESSION_COOKIE,result.token,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:365*24*60*60});
  return response;
}
