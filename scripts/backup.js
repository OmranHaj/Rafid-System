import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const source=resolve(process.argv[2]||'data/rafid.sqlite');
const destination=process.argv[3]&&resolve(process.argv[3]);
if(!destination||source===destination||existsSync(destination))throw new Error('Usage: node scripts/backup.js SOURCE NEW_DESTINATION (destination must not exist)');
mkdirSync(dirname(destination),{recursive:true});
const database=new DatabaseSync(source,{readOnly:true});
try{await backup(database,destination);const check=new DatabaseSync(destination,{readOnly:true});try{const result=check.prepare('PRAGMA integrity_check').get();if(result.integrity_check!=='ok')throw new Error('Backup integrity check failed');console.log('Verified backup:',destination);}finally{check.close();}}finally{database.close();}
