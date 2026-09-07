#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const directory=path.join(root,'tests/acceptance');
const tests=fs.readdirSync(directory).filter(f=>f.endsWith('.test.cjs')).sort().map(f=>path.join(directory,f));
if(!tests.length){console.error('No acceptance-oracle tests discovered');process.exit(2);}
const env={...process.env};for(const key of Object.keys(env))if(key.includes('API_KEY')||key.includes('ADMIN_TOKEN')||key==='DATABASE_URL')delete env[key];
const result=spawnSync(process.execPath,['--require',path.join(__dirname,'network-guard.cjs'),'--test',...tests],{cwd:root,env,stdio:'inherit'});
if(result.status===0)console.log('OFFLINE_ORACLE_PASS — evaluator/transport regression checks only; real-agent acceptance remains NOT_RUN.');
process.exitCode=result.status??2;
