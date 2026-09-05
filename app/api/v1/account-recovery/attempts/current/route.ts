
import { NextResponse } from "next/server";
function retired() { return NextResponse.json({code:"RECOVERY_RETIRED",message:"Восстановление через друзей удалено. Используйте личный код."},{status:410,headers:{"Cache-Control":"no-store"}}); }
export {retired as GET,retired as POST,retired as DELETE};
