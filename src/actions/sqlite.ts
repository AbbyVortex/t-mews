import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const tables=['posts','source_health','state','events','notifications'] as const;
export interface Snapshot { version:1; tables:Record<string,Record<string,any>[]> }
export class LocalD1 {
 readonly sqlite=new DatabaseSync(':memory:');
 constructor(snapshot?:Snapshot) {
  this.sqlite.exec(readFileSync(new URL('../../migrations/0001_initial.sql',import.meta.url),'utf8'));
  if(snapshot) {
   if(snapshot.version!==1||tables.some(t=>!Array.isArray(snapshot.tables?.[t])))throw new Error('Invalid saved state; refusing to reset baseline');
   this.sqlite.exec('BEGIN');
   try {
    for(const table of tables) {
     const columns=(this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(r=>r.name);
     const insert=this.sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
     for(const row of snapshot.tables[table])insert.run(...columns.map(c=>row[c]??null));
    }
    this.sqlite.exec('COMMIT');
   }catch(e){this.sqlite.exec('ROLLBACK');throw e;}
  }
 }
 prepare(sql:string) {return new Statement(this,sql);}
 async batch(statements:Statement[]) {
  this.sqlite.exec('BEGIN');
  try {const results=await Promise.all(statements.map(s=>s.all()));this.sqlite.exec('COMMIT');return results;}
  catch(e){this.sqlite.exec('ROLLBACK');throw e;}
 }
 snapshot():Snapshot {return {version:1,tables:Object.fromEntries(tables.map(t=>[t,this.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]))};}
 asD1():D1Database {return this as unknown as D1Database;}
 close(){this.sqlite.close();}
}
class Statement {
 constructor(private db:LocalD1,private sql:string,private args:any[]=[]){ }
 bind(...args:any[]) {return new Statement(this.db,this.sql,args);}
 async first<T=Record<string,any>>(column?:string):Promise<T|null> {const row=this.db.sqlite.prepare(this.sql).get(...this.args);return (column?row?.[column]:row) as T??null;}
 async all<T=Record<string,any>>() {const results=this.db.sqlite.prepare(this.sql).all(...this.args) as T[];return {results,success:true,meta:{}};}
 async run(){return this.all();}
}
