
import {randomBytes} from "node:crypto";
import {mkdirSync,writeFileSync,chmodSync} from "node:fs";
import {fileURLToPath} from "node:url";
const directory=fileURLToPath(new URL("../deploy/.secrets/",import.meta.url));
mkdirSync(directory,{recursive:true,mode:0o700});
chmodSync(directory,0o700);
for(const name of ["db_admin","db_migration","db_app"]) {
  try {writeFileSync(directory+name,randomBytes(36).toString("base64url")+"\n",{mode:0o444,flag:"wx"});}
  catch(error){if(error.code!=="EEXIST")throw error;}
}
console.log("Secret files ready; existing files were preserved. Values are not printed.");
