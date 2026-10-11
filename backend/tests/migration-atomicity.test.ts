import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/main/persistence/db.js';

describe('Atomic schema upgrades', () => {
  let root: string;
  afterEach(() => { vi.restoreAllMocks();closeDb();if(root)rmSync(root,{recursive:true,force:true}); });
  it('rolls back an interrupted confirmation-table rebuild and can retry without loss', () => {
    root=mkdtempSync(path.join(tmpdir(),'migration-interruption-'));
    const filename=path.join(root,'profile.db');
    const old=new Database(filename);
    old.exec(readFileSync(path.resolve('backend/src/main/persistence/schema.sql'),'utf8').replace(",'uncontained_python'",''));
    old.prepare("INSERT INTO kv_meta(key,value) VALUES ('schema_version','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
    old.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES ('chat','History','now','now')").run();
    old.prepare("INSERT INTO runs(id,chat_id,state,user_text_summary,created_at) VALUES ('run','chat','partial','Saved task','now')").run();
    old.prepare("INSERT INTO confirmations(action_id,run_id,kind,prompt,created_at,expires_at) VALUES ('approval','run','execute_python','Saved approval','now','later')").run();
    old.close();
    const actual=Database.prototype.exec;
    const fault=vi.spyOn(Database.prototype,'exec').mockImplementation(function(this: Database.Database,sql:string){
      if(sql.includes('DROP TABLE confirmations;')){
        actual.call(this,sql.slice(0,sql.indexOf('DROP TABLE confirmations;')));
        throw new Error('Injected interruption during upgrade');
      }
      return actual.call(this,sql);
    });
    expect(()=>initDb(filename)).toThrow(/Injected interruption/);
    fault.mockRestore();
    const after=new Database(filename,{readonly:true});
    expect(after.prepare("SELECT prompt FROM confirmations WHERE action_id='approval'").get()).toEqual({prompt:'Saved approval'});
    expect(after.prepare("SELECT value FROM kv_meta WHERE key='schema_version'").get()).toEqual({value:'2'});
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='confirmations_new'").get()).toBeUndefined();
    after.close();
    const upgraded=initDb(filename);
    expect(upgraded.prepare("SELECT prompt FROM confirmations WHERE action_id='approval'").get()).toEqual({prompt:'Saved approval'});
    expect(upgraded.prepare("SELECT value FROM kv_meta WHERE key='schema_version'").get()).toEqual({value:'3'});
    expect(upgraded.pragma('foreign_keys',{simple:true})).toBe(1);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.prepare("SELECT sql FROM sqlite_master WHERE name='confirmations'").get()).toMatchObject({sql:expect.stringContaining('uncontained_python')});
  });
});
