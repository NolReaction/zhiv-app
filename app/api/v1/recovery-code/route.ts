
import {cookies} from "next/headers";
import {NextResponse} from "next/server";
import {guardDevApi} from "@/lib/dev-api-guard";
import {NO_STORE_HEADERS} from "@/lib/dev-api-route";
import {SESSION_COOKIE,devRecoveryCodeState,activateDevRecoveryCode} from "@/lib/dev-api-store";
import {normalizeRecoveryCode} from "@/lib/recovery-code";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  const rejected=guardDevApi(request);if(rejected)return rejected;
  const state=devRecoveryCodeState((await cookies()).get(SESSION_COOKIE)?.value);
  return NextResponse.json(state??{code:"UNAUTHORIZED",message:"Сессия не найдена"},{status:state?200:401,headers:NO_STORE_HEADERS});
}
export async function PUT(request:Request){
  const rejected=guardDevApi(request,true);if(rejected)return rejected;
  const body=await request.json().catch(()=>null);
  const code=typeof body?.code==="string"?normalizeRecoveryCode(body.code):null;
  if(!code)return NextResponse.json({code:"INVALID_CODE",message:"Создайте новый код"},{status:400,headers:NO_STORE_HEADERS});
  const result=activateDevRecoveryCode((await cookies()).get(SESSION_COOKIE)?.value,code);
  if(result.kind==="ok")return NextResponse.json(result.value,{headers:NO_STORE_HEADERS});
  return NextResponse.json({code:result.kind==="unauthorized"?"UNAUTHORIZED":"CODE_CONFLICT",message:"Код не активирован. Проверьте сессию."},{status:result.kind==="unauthorized"?401:409,headers:NO_STORE_HEADERS});
}
